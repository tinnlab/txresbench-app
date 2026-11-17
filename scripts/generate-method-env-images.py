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

  - docs/method-env-layer-artifacts.md — the artifact contract:
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
  - It does NOT trim the per-language base and does NOT re-wrap or re-gate
    methods. It packs the app-side base squashfs from the very base rootfs
    the layers' deltas were computed against (see THE BASE ARTIFACT). The
    methods repository is a read-only build-time input
    (CONS-method-env-images-1); the only network use is a base batch's
    (--new-base) docker pull of a missing base image — a pinned build
    pulls nothing.

THE STAGED OUTPUT (one directory per (env, arch)):

  <out>/layers/<env_id>-<arch>/
    layer.squashfs     the zstd squashfs (the OCI artifact's single file)
    artifact.json      the record the manifest writer consumes
    oci-manifest.json  the exact OCI artifact manifest bytes (written by
                       the writer's --manifest mode; ITEM-5 pushes these
                       bytes, so its digest is the recorded `digest`)
  <out>/bases/<base_id>-<arch>/          (base_id: base-py | base-r)
    base.squashfs      the app-side base the stacked run mounts under every
                       layer of that language and arch (the OCI artifact's
                       single file)
    artifact.json      its record (kind "base")
    oci-manifest.json  its exact OCI artifact manifest bytes (written by the
                       writer's --manifest mode, like the layers')
  <out>/base-cache/<base-digest16>-<arch>/
    rootfs/            the extracted base rootfs (reused across methods of
                       that language; the delta base index sits next to it)
  <out>/work/<env_id>-<arch>/   extraction scratch; removed unless --keep-rootfs

THE BASE ARTIFACT
-----------------
Every layer is a delta over one Docker base image (its record's base_ref +
base_digest). The app stacks the layer on the app-side base of the same
language and arch, so the generator packs that base from the SAME cached
rootfs the delta used (same image digest), once per build dir: after each
method build (kept when already staged from the same image), or with
--stage-bases for layer records already in --out. The pack is checked
first (the sandbox needs /opt/txr-layer, /usr/bin/prlimit and /usr/bin/bash;
base-r also /opt/txr-layer/R-library) and uses fixed timestamps, so one
rootfs packs to the same bytes every time. The manifest's `bases` record
pins the sha256 of the staged file; the app verifies the downloaded base
against it, and checks at load that each entry's base_ref/base_digest equal
its base's source_ref/source_digest (design §7). A build dir holds one base
per language and arch: a layer built on another base image is refused.

artifact.json is the ONLY hand-off from the build to the manifest writer. It
records everything the writer cannot derive from the index: the precise base
the delta was computed against (ref + digest + how the digest was obtained),
the layer file hash/size, the wrapper hash per the design doc's pinned byte
convention (§2.2), the layer-manifest entries, and the delta statistics the
ITEM-6 report summarizes (outside the repo, in the worker's report).

ONE METHOD AT A TIME (0.5.0)
----------------------------
A build takes the method's COMMITTED folder at the methods HEAD: it refuses
a folder that is not in HEAD (an untracked folder), that has uncommitted
changes or untracked files (the folder or its gates/<id>.json), or whose
gate did not pass; the build context is `git archive HEAD methods/<id>`.
Every fact comes from that folder: the version and language from
method.json, the base ref and the contract (its tag) from the Dockerfile's
FROM; the generated index.json is never read (AUDIT P7). The record carries
the commit (`source_revision`) and the folder's git tree (`source_tree`).

The base is the Docker image the current list pins (`bases[]`:
source_ref + source_digest; `--base-pins <list>`, default the committed
list), taken from THIS machine's image store by digest: never pulled (the
base images are not published) and never rebuilt (a rebuilt base has
another digest). A method is built on the machine that holds its pinned
base; a base image moves between machines by `docker save` / `docker load`,
its digest checked after the load. `--new-base` starts a base batch instead
(the base resolved as before, staged, and every layer on it rebuilt).

THE MANIFEST WRITER (ITEM-3)
----------------------------

  python3 scripts/generate-method-env-images.py --out <dir> --manifest <path> (--previous <list> | --full)
      build the selected methods, then assemble + write the manifest.
  python3 scripts/generate-method-env-images.py --assemble <dir> --manifest <path> (--previous <list> | --full)
      assemble only (no docker) from the records under <dir> (`--fixture`
      is the old name of `--assemble`).
  python3 scripts/generate-method-env-images.py --check --assemble <dir> [--manifest <path>]
          [--previous <list>] [--entry <env_id>-<arch>] [--base-entry <base_id>-<arch>]
      parity, no docker: by default the whole list re-assembles byte for
      byte from <dir>; with --previous, an entry byte-identical to that list
      is carried and every other entry re-assembles from its own record;
      with --entry/--base-entry, those entries only. Exit 0 = identical, 1 =
      differs with the first differing key named, 2 = usage error.
  python3 scripts/generate-method-env-images.py --check-provenance [--manifest <path>] [--entry ...]
      every entry's facts against the methods repository at its own commit.

`--full`: every entry from a record, the bases from the staged base records.
`--previous`: the previous list's entries and bases are carried untouched;
each record replaces or adds its (env_id, arch); `--drop <env_id>-<arch>`
removes one; a record built on another base image than the list pins is
refused, except in a base batch (`--replace-base <base_id>-<arch>` takes the
staged base: when its source image changed, every entry on it must be
rebuilt in the same assembly, or dropped). Writing a manifest without one
of the two is a usage error (no one-method list by accident).

Entry fields come from the record (everything the build measured) and from
git at the record's own commit: the gate, method.json's version, language
and licence (verbatim — TEST-11), the Dockerfile's FROM and its tag (the
contract), the run file and the wrapper hash, and the folder tree (taken
from git for a record from a generator before 0.5.0, which has none); the
methods HEAD does not matter. `oci_ref`/`tag` are derived from the record's
env_id, method_version, arch and layer_sha256 (the one layer package, tag
`<env_id>-<method_version>-<arch>-<first 12 hex of layer_sha256>`; a base:
the one base package, tag `<base_id>-<contract>-<arch>-<sha12>`). A record's
own address must be that form or the one-package-per-method form a
generator before 0.4.0 wrote, so a build dir staged before 0.4.0 still
assembles, to the same digests (the OCI manifest bytes carry no address);
`digest` is the sha256 of the exact OCI artifact manifest bytes the item's
publisher must push (construction pinned in design §6). Determinism (INV-5,
DEC-15): no wall-clock field, entries sorted by (env_id, arch), pinned key
order; each entry records its own `source_revision`, `source_tree` and the
`generator_version` that built it (schema 2).

LAYOUT NOTE: the squashfs root IS the layer filesystem root — the runtime
mounts the layer dir and binds <layer_dir>/<entry> (stack.rs's
--ro-bind-try loop) — so /code, /usr/… and /opt/… sit at the squashfs root
next to /.txr-method-env-layer-schema and /layer-manifest.json.

WHAT THE SHIPPED CODE ALREADY PROVED (do not re-derive):

  - the extract shape (docker create + export a built image) is the
    framework's env-image publish step 2 and the CI workflow it mirrors;
  - the packer flags are the framework's env-recipe packer stage:
    mksquashfs -comp zstd -Xcompression-level 22 -b 1M -all-root;
  - the 0600-wrapper failure is a repeated benchmark record (the container's
    non-root user cannot read /code/run.py), which is why a wrapper below
    0644 read bits is a HARD ERROR (design §3.1) and every other file is
    normalized (files >= 0644, dirs >= 0755);
  - the generated-artifact discipline is the byte-parity pin: this script
    emits no wall-clock field,
    sorts every emitted array, and writes no temp path into any record, so
    ITEM-3's byte-parity --check is reachable.

USAGE
-----
  python3 scripts/generate-method-env-images.py --out <dir>               # every gated method at HEAD
  python3 scripts/generate-method-env-images.py --out <dir> --only <id>  # one method, on the pinned base
  python3 scripts/generate-method-env-images.py --dry-run --out <dir>    # print the sequence, run nothing
  python3 scripts/generate-method-env-images.py --out <dir> --manifest <path> --previous <list>
  python3 scripts/generate-method-env-images.py --assemble <dir> --manifest <path> --previous <list>
  python3 scripts/generate-method-env-images.py --check --assemble <dir> --previous <list>
  python3 scripts/generate-method-env-images.py --check-provenance --methods-dir <dir>
  python3 scripts/generate-method-env-images.py --stage-bases --out <dir> --arch <a>  # bases for staged layers

  --arch            amd64 (default) | arm64; a cross-arch build is refused
                    unless ALLOW_EMULATED_BUILD=1 (mirror of
                    the framework's publish script: qemu bytes must not be staged
                    by accident, DEC-10).
  --methods-dir     the methods repository, a git checkout (default
                    $TXR_METHODS_DIR, else /data/share/pbya/sigtrans/methods —
                    the plan's CONS-1 default).
  --benchmark-dir   the benchmark tree root used ONLY as the fallback base
                    source of --new-base (docker-images/base-<lang> there)
                    when a FROM base is neither local nor pullable (default:
                    dirname(methods-dir)/dev/code/benchmark).
  --base-pins <list> build on the bases this list pins (default: the
                    committed list).
  --new-base        a base batch: resolve the base as before (local, pull,
                    benchmark tree) and stage it.
  --manifest <path> assemble + write the manifest (from this run's records,
                    or from the --assemble records); with --check /
                    --check-provenance, the file to check (default
                    src-app/server/data/method-env-images.json).
  --previous <list> / --full   how a manifest is assembled or checked (above).
  --replace-base <base_id>-<arch>, --drop <env_id>-<arch>   (with --previous).
  --check           parity, assemble-only (above).
  --entry / --base-entry   the entries a --check or --check-provenance covers.
  --assemble <dir>  read records from <dir>/layers and <dir>/bases (never
                    builds; --fixture is the old name).
  --stage-bases     build nothing; stage the base artifact of every language
                    the --arch layer records in --out use, from the cached
                    base rootfs, or from the LOCAL base image when its digest
                    equals the records' base_digest (never pulled or rebuilt:
                    a rebuilt base has another digest and would not pair).
  --no-trim         debugging only (DEC-12: trim constants are fixed).
  --keep-rootfs     keep the extracted rootfs + scratch (debugging).
  --force-base-build  with --new-base: skip the local/pull base lookup; build
                    the base from the benchmark tree (the owner's "bases
                    published or build from src" step).

EXIT CODES
----------
  0  every selected method produced a staged layer (and, with --manifest,
     the manifest was written; with --check, the parity matched)
  2  usage error
  1  a method failed — the FIRST failure is reported and the run stops
     (a silent skip of a runnable method is forbidden: DEC-8's rule that
     exactly the runnable methods are covered); or, with --check /
     --check-provenance, the list differs

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
#: deliberate, never silent. 0.4.0: every layer in ONE package (the method and
#: the first 12 hex of its layer_sha256 in the tag) and both bases in ONE
#: package (the base in the tag). 0.5.0: one method at a time — the build
#: takes the method's committed folder (clean, at HEAD) and the base the
#: current list pins; the manifest records the methods commit, the folder's
#: git tree and the building generator PER ENTRY (schema 2), and a list is
#: assembled from the previous list's entries plus the new records. 0.6.0:
#: layers pack with fixed times, and their OCI manifest carries no methods
#: commit or base image, so one layer file is one artifact (FOLLOW-UPS 64).
#: 0.6.1: the trim keeps the package dirs in TRIM_KEEP_PACKAGE_DIRS (the
#: TensorFlow layers could not import tensorflow); every other layer is built
#: as under 0.6.0.
GENERATOR_VERSION = "0.6.1"

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

#: Where a method's own packages live (the bases' mount point, tinnlab/txresbench base-images): pip and R
#: install there by default. Everything under it is ONE layer entry, so a stacked run binds the whole
#: folder onto the mount point the base provides. Must match stack.rs METHOD_PACKAGES_DIR.
METHOD_PACKAGES_DIR = "/opt/txr-layer"

#: Trim rules (DEC-12, design §4) — the shipped single-cell recipe's own
#: set, as fixed constants (DEC-13: no settings row, no per-method profile).
#: KEPT: `.pyi`/`.pyx`/`.pxd` (skimage/scipy lazy loaders read them), R
#: package metadata (Meta/, R/) and man pages.
TRIM_DIR_NAMES = frozenset(
    ("include", "tests", "test", "docs", "doc", "examples", "__pycache__")
)
TRIM_FILE_SUFFIXES = (".pyc", ".a")
#: Package dirs the trim keeps although they have a trim name: code that a
#: package imports when it is imported, not tests or docs (design §4). Each is
#: a path below a site-packages dir; a trim-named dir that is one of them or
#: sits under one is kept, except `__pycache__` (a layer carries no bytecode).
#:   tensorflow/tools/docs  doc_controls, imported by
#:                          tensorflow/python/util/deprecation.py
#:   tensorflow/_api        TensorFlow's generated API modules;
#:                          tensorflow/__init__.py imports the `test` ones
#:                          (tf.test, tf.__internal__.test, the tf.compat copies)
#: Without them `import tensorflow` fails in the layer: the only environment
#: failures in the 2026-11-16 run test of 370 amd64 layers. A general rule
#: ("keep any test/docs dir with an __init__.py") would also keep joblib's
#: test suite (joblib/test) and change 20 more built layers.
TRIM_KEEP_PACKAGE_DIRS = ("tensorflow/tools/docs", "tensorflow/_api")
STRIP_PATTERN = re.compile(r"\.so(\.|$)")

#: The per-language base the method Dockerfiles must start FROM (INV-1: the
#: layer is the method's own bytes over its own base, never a hand-authored
#: re-install). The classifier is the ONLY place the base ref is derived,
#: so a build and its own record cannot disagree.
BASE_REF_RE = re.compile(r"^ghcr\.io/tinnlab/txresbench-base-(r|py):([0-9]+\.[0-9]+)$")
BASE_LANG_BY_KEY = {"r": "R", "py": "Python"}
CONTRACT_RE = re.compile(r"^[0-9]+\.[0-9]+$")

#: The ONE OCI package every method layer is published in (DEC-2's
#: namespace): every entry's oci_ref is exactly this, and the method is in
#: the tag, `<env_id>-<method_version>-<arch>-<sha12>` (layer_tag). One
#: package for all layers, so a new method needs no new package (GHCR sets
#: visibility per package, by hand). Spelled WITHOUT a scheme like the
#: shipped stack.rs registry constant, so no new host enters the allowlist
#: (DEC-17).
LAYER_OCI_REF = "ghcr.io/tinnlab/txr-method-env-layers"

#: The ONE OCI package both app-side bases are published in (design §6.3,
#: the sandbox's base package): every bases[] record's oci_ref is exactly
#: this, and the base is in the tag, `<base_id>-<contract>-<arch>-<sha12>`
#: (base_tag). Spelled without a scheme like LAYER_OCI_REF.
BASE_OCI_REF = "ghcr.io/tinnlab/txresbench-env"

#: The OCI distribution tag grammar: at most 128 characters, the first not
#: `.` or `-`. A layer tag carries the env id, so its length is checked.
OCI_TAG_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$")


def layer_tag(env_id: str, method_version: str, arch: str,
              layer_sha256: str) -> str:
    """A layer's immutable tag in the one layer package. It ends with the
    first 12 hex of the layer file's sha256 (like a base tag): a rebuild at
    the same method version (another base, a package fix; layers are not
    byte-reproducible) is a new tag, never an overwrite of the old one."""
    return f"{env_id}-{method_version}-{arch}-{layer_sha256[:12]}"


def legacy_layer_address(env_id: str, method_version: str,
                         arch: str) -> tuple[str, str]:
    """The (oci_ref, tag) a generator before 0.4.0 wrote into a layer
    record: one package per method. Accepted ONLY in a staged record (the
    writer derives the current address from the record's env_id,
    method_version and arch); a manifest never carries it."""
    return f"{LAYER_OCI_REF}/{env_id}", f"{method_version}-{arch}"


BASE_ID_BY_LANG = {"R": "base-r", "Python": "base-py"}
BASE_DIR_RE = re.compile(r"^(base-(?:r|py))-(amd64|arm64)$")
BASE_FILE = "base.squashfs"

#: What every base must hold for the stacked run (checked before packing):
#: the layer mount point (stack.rs METHOD_PACKAGES_DIR) and the two programs
#: the sandbox argv runs (sandbox.rs: /usr/bin/prlimit, then /bin/bash). The
#: sandbox binds the base's /usr and makes /bin a link to usr/bin itself, so
#: /bin/bash is the base's usr/bin/bash, whatever the base's own /bin is.
BASE_REQUIRED = {
    "base-py": (("opt/txr-layer", "dir"), ("usr/bin/prlimit", "file"),
                ("usr/bin/bash", "file")),
    "base-r": (("opt/txr-layer", "dir"), ("opt/txr-layer/R-library", "dir"),
               ("usr/bin/prlimit", "file"), ("usr/bin/bash", "file")),
}

#: Every timestamp in a base squashfs (file times + the superblock's
#: creation time): 1980-01-01T00:00:00Z. The extracted rootfs carries
#: extraction times, so without a fixed time two packs of one rootfs differ;
#: 1980 stays clear of tools that refuse pre-1980 times (zip).
BASE_SQUASHFS_TIME = "315532800"

#: The base pack flags: the layer's compressor flags + fixed times + no
#: xattrs (the extracted rootfs carries none; the build host's must not leak).
BASE_MKSQUASHFS_FLAGS = (
    "-comp", "zstd", "-Xcompression-level", "22", "-b", "1M", "-noappend",
    "-no-progress", "-all-root", "-no-xattrs",
    "-all-time", BASE_SQUASHFS_TIME, "-mkfs-time", BASE_SQUASHFS_TIME,
)

#: The layer pack flags: the framework's env-recipe packer stage plus the
#: base's fixed times and no xattrs (BASE_MKSQUASHFS_FLAGS), so one layer root
#: packs to the same bytes every time (FOLLOW-UPS 64). The materialized root
#: carries extraction times; without a fixed time, rebuilding an unchanged
#: code-only method gave a new file, a new tag and a new download. A layer
#: carries no Python bytecode to go stale (trim_layer removes every .pyc and
#: __pycache__, DEC-12), so fixed times change no import behaviour.
LAYER_MKSQUASHFS_FLAGS = BASE_MKSQUASHFS_FLAGS

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
#: (schema_version 1 == the seed emitted by ITEM-1; 2 == the methods commit,
#: the folder tree and the building generator per entry, no top-level
#: source_revision).
MANIFEST_SCHEMA_VERSION = 2

#: The artifact record versions the writer reads: 1 (generators before
#: 0.5.0: no folder tree recorded; the writer derives it from git at the
#: record's commit) and 2 (0.5.0: built from the committed folder, with its
#: git tree).
RECORD_SCHEMA_VERSION = 2
RECORD_SCHEMA_VERSIONS = (1, 2)

#: The one container-contract line a list carries (`base_contract`); every
#: entry's contract and every base's contract equal it.
BASE_CONTRACT = "2.0"

#: A method version: X.Y.Z with an optional `-`/`.` suffix. No `+`: the
#: version is part of the layer's OCI tag, which cannot hold one
#: (FOLLOW-UPS 72).
METHOD_VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$")

#: A generator version as a record or an entry carries it (X.Y.Z, with an
#: optional pre-release suffix for the dev publisher's own records).
GENERATOR_VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$")

#: A method folder's git tree id (`git rev-parse <commit>:methods/<id>`); the
#: methods repository uses SHA-1 object ids.
SOURCE_TREE_RE = re.compile(r"^[0-9a-f]{40}$")

#: The fields of one emitted `envs[]` entry, in the schema's order.
ENV_FIELDS = ("env_id", "method_id", "method_version", "language", "arch",
              "oci_ref", "tag", "digest", "layer_sha256", "size_bytes",
              "base_ref", "base_digest", "contract", "licence",
              "wrapper_code_sha256", "layer_schema", "source_revision",
              "source_tree", "generator_version")

#: The OCI artifact type (DEC-14) — the manifest's `artifactType` AND the
#: single file's media type (the publisher's `oras push` spells the file as
#: `layer.squashfs:<ARTIFACT_TYPE>`, exactly the framework's publish shape).
ARTIFACT_TYPE = "application/vnd.txr.method-env.layer.v1"

#: The base artifact's type (design §6.3) — the manifest's artifactType AND
#: the single file's media type, like the layer's.
BASE_ARTIFACT_TYPE = "application/vnd.txr.method-env.base.v1"

#: The base artifact's source annotation: the repository holding the base
#: image recipes (base-images/). Build-time annotation data only.
BASE_SOURCE_URL = "https://github.com/tinnlab/txresbench"

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
    if any(_trimmed_dir(parts[: i + 1]) for i in range(len(parts))):
        return True
    return kind == "file" and p.endswith(TRIM_FILE_SUFFIXES)


def _trimmed_dir(parts: list[str]) -> bool:
    """Whether the dir at these path components (from the rootfs or layer
    root) is trimmed: a TRIM_DIR_NAMES name, unless it is or sits under a
    TRIM_KEEP_PACKAGE_DIRS path below a site-packages dir. `__pycache__` is
    always trimmed. trim_delta and trim_layer both decide with this."""
    name = parts[-1]
    if name not in TRIM_DIR_NAMES:
        return False
    if name == "__pycache__" or "site-packages" not in parts:
        return True
    rel = "/".join(parts[parts.index("site-packages") + 1:])
    return not any(rel == k or rel.startswith(k + "/") for k in TRIM_KEEP_PACKAGE_DIRS)


def closed_cover(delta: Delta, method_root: str, base_root: str) -> list[str]:
    """Derive the subtree-closed cover of the delta (design §5.1) and REFUSE
    what cannot be a layer under the frozen contract (§5.2).

    Rules, in order — each is the reason the emitted entry list makes the
    runtime's per-entry bind loop equivalent to an overlay union (§8):

      0. Everything under METHOD_PACKAGES_DIR (/opt/txr-layer, where pip and
         R install a method's packages) is the one entry /opt/txr-layer.
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
      7. Every entry but /code must already exist in the base: the sandbox
         mounts the base's /usr and /opt read-only, so bwrap cannot create a
         mount point for a new path there ("Can't mkdir ...: Read-only file
         system" at run time). Such a layer is refused here instead, naming
         the paths; a method installs its packages into /opt/txr-layer.
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
        packages_rel = METHOD_PACKAGES_DIR.lstrip("/")
        if p == packages_rel or p.startswith(packages_rel + "/"):
            entries.add(METHOD_PACKAGES_DIR)
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
    no_mount_point = sorted(e for e in entries if e != "/code"
                            and not os.path.lexists(os.path.join(base_root, e.lstrip("/"))))
    if no_mount_point:
        raise BuildError(
            "layer entries the base has no mount point for; the sandbox mounts "
            "the base's /usr and /opt read-only, so these paths could not be "
            "mounted at run time. Install the method's packages into "
            f"{METHOD_PACKAGES_DIR} (the bases' pip and R default) instead of "
            "the base's own folders:\n  " + "\n  ".join(no_mount_point))
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
        rel_dir = os.path.relpath(dirpath, layer_root)
        parts = [] if rel_dir == "." else rel_dir.split(os.sep)
        for d in list(dirnames):
            if _trimmed_dir(parts + [d]):
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
    the framework's env-image publish path. Every build-stage process is launched through the
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
    shipped publish sequence (step 2) proves. `docker create` needs no
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

# ─────────────────── the methods repository (git, per method) ────────────────
#
# Every method fact the list carries is read from the method's OWN committed
# files at the commit its layer was built from — never from the generated,
# gitignored index.json (AUDIT P7: a stale index named the wrong version of
# two shipped entries). A build takes the method's folder from HEAD, refused
# when it is dirty or untracked; the writer re-reads the facts at each
# record's own commit, so the methods repository's HEAD never matters to an
# assembly.

class ProvenanceError(Exception):
    """A method fact that cannot be read or does not hold at a commit; the
    message starts with a stable code (PROVENANCE_*)."""


class Git:
    """The few read-only git calls the generator makes on the methods
    repository (`git -C <dir>`, bytes out)."""

    def __init__(self, repo: str) -> None:
        self.repo = repo

    def _git(self, *args: str, check: bool = False) -> subprocess.CompletedProcess:
        try:
            return subprocess.run(["git", "-C", self.repo, "-c", "core.quotepath=off",
                                   *args], capture_output=True, check=check)
        except FileNotFoundError as e:
            raise SystemExit(f"git is not on PATH: {e}") from e

    def is_repo(self) -> bool:
        """Whether the dir is a git checkout's TOP level (every path the
        generator reads is relative to it: methods/<id>, gates/<id>.json)."""
        p = self._git("rev-parse", "--show-toplevel")
        if p.returncode != 0:
            return False
        top = p.stdout.decode().strip()
        return os.path.realpath(top) == os.path.realpath(self.repo)

    def commit(self, rev: str) -> str | None:
        """The full commit id `rev` names, or None."""
        p = self._git("rev-parse", "--verify", "--quiet", rev + "^{commit}")
        out = p.stdout.decode().strip()
        return out if p.returncode == 0 and re.match(r"^[0-9a-f]{40}$", out) else None

    def tree(self, commit: str, path: str) -> str | None:
        """The tree id of `path` at `commit`, or None when it is absent or not
        a directory."""
        p = self._git("rev-parse", "--verify", "--quiet", f"{commit}:{path}")
        oid = p.stdout.decode().strip()
        if p.returncode != 0 or not oid:
            return None
        t = self._git("cat-file", "-t", oid)
        return oid if t.returncode == 0 and t.stdout.strip() == b"tree" else None

    def blob(self, commit: str, path: str) -> bytes | None:
        """The bytes of file `path` at `commit`, or None."""
        p = self._git("cat-file", "blob", f"{commit}:{path}")
        return p.stdout if p.returncode == 0 else None

    def names(self, commit: str, path: str) -> list[str]:
        """The entry names directly under `path` at `commit`."""
        p = self._git("ls-tree", "--name-only", commit, path.rstrip("/") + "/")
        if p.returncode != 0:
            return []
        return sorted(os.path.basename(line) for line in
                      p.stdout.decode().splitlines() if line)

    def dirty(self, *paths: str) -> list[str]:
        """`git status --porcelain` lines (modified, staged, deleted or
        untracked) under `paths`."""
        p = self._git("status", "--porcelain=v1", "--untracked-files=all", "--", *paths)
        if p.returncode != 0:
            raise SystemExit(f"git status failed in {self.repo}: "
                             f"{p.stderr.decode(errors='replace')[-500:]}")
        return [line for line in p.stdout.decode().splitlines() if line]

    def archive(self, commit: str, path: str, tar_path: str) -> None:
        """`git archive` of `path` at `commit` into `tar_path`, with the
        usual 0644/0755 modes (tar.umask 022) whatever the host's umask."""
        with open(tar_path, "wb") as out:
            p = subprocess.run(["git", "-C", self.repo, "-c", "tar.umask=0022",
                                "archive", "--format=tar", commit, "--", path],
                               stdout=out, stderr=subprocess.PIPE)
        if p.returncode != 0:
            raise BuildError(f"git archive {commit[:12]} {path} failed: "
                             f"{p.stderr.decode(errors='replace')[-500:]}")


def methods_git(methods_dir: str) -> Git:
    git = Git(methods_dir)
    if not os.path.isdir(methods_dir) or not git.is_repo():
        raise SystemExit(
            f"the methods dir {methods_dir} is not a git checkout (its top level): "
            "every method fact is read from the method's committed files at its "
            "recorded commit (--methods-dir / TXR_METHODS_DIR)")
    return git


def _parse_from(text: str, where: str) -> tuple[str, str]:
    """Read the first FROM of a Dockerfile's text and classify it (design §3
    step 1). Refuses a Dockerfile that does not start FROM a per-language
    benchmark base (INV-1). `FROM` may carry a `--platform=` arg (buildx
    syntax); ARG lines may precede it. Returns (base_ref, 'r'|'py')."""
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or stripped.startswith("ARG "):
            continue
        m = re.match(r"^FROM(?:\s+--platform=\S+)?\s+(\S+)\s*$", stripped)
        if m:
            ref = m.group(1)
            bm = BASE_REF_RE.match(ref)
            if not bm:
                raise BuildError(
                    f"Dockerfile {where} does not start FROM a "
                    "per-language benchmark base (INV-1: the layer is the "
                    f"method's own bytes, never a hand-authored base): {ref!r}. "
                    "Accepted shape: "
                    "FROM ghcr.io/tinnlab/txresbench-base-(r|py):<contract>.")
            return ref, bm.group(1)
        raise BuildError(
            f"Dockerfile {where}: the first build instruction is "
            f"{stripped!r}, not FROM (INV-1)")
    raise BuildError(f"Dockerfile {where} has no FROM line")


def classify_from(dockerfile_path: str) -> tuple[str, str]:
    """`_parse_from` over a Dockerfile on disk. The match happens BEFORE any
    docker call — an unclassifiable FROM never costs a build, and a build
    never records a base ref different from the one the classifier
    accepted."""
    with open(dockerfile_path) as f:
        return _parse_from(f.read(), dockerfile_path)


def method_facts_at(git: Git, commit: str, eid: str) -> dict:
    """Every fact the list takes from a method, read from its committed
    files at `commit`: the folder's tree, method.json (id, version, language,
    licence), the Dockerfile's FROM (base_ref; its tag is the contract), the
    one run file and the wrapper hash (design §2.2), and whether
    gates/<id>.json says the method passed its gate (DEC-8: exactly the
    runnable methods get a layer). Raises ProvenanceError with a code."""
    folder = f"methods/{eid}"
    at = f"{folder} at {commit[:12]}"
    tree = git.tree(commit, folder)
    if tree is None:
        raise ProvenanceError(
            f"PROVENANCE_METHOD_NOT_IN_COMMIT: {folder} is not in commit "
            f"{commit[:12]} of the methods repository (a folder that was never "
            "committed has no provenance)")
    mj = git.blob(commit, f"{folder}/method.json")
    if mj is None:
        raise ProvenanceError(f"PROVENANCE_METHOD_NOT_IN_COMMIT: {at} has no method.json")
    try:
        spec = json.loads(mj)
    except ValueError as e:
        raise ProvenanceError(f"PROVENANCE_FACT_MISMATCH: {at}: method.json is not "
                              f"valid JSON: {e}") from e
    if not isinstance(spec, dict):
        raise ProvenanceError(f"PROVENANCE_FACT_MISMATCH: {at}: method.json is not an object")
    if spec.get("id") != eid:
        raise ProvenanceError(f"PROVENANCE_FACT_MISMATCH: {at}: method.json id "
                              f"{spec.get('id')!r} is not {eid!r}")
    version = spec.get("version")
    if not isinstance(version, str) or not METHOD_VERSION_RE.match(version):
        raise ProvenanceError(f"PROVENANCE_FACT_MISMATCH: {at}: method.json version "
                              f"{version!r} is not X.Y.Z (the registry tag needs it)")
    language = spec.get("language")
    if language not in BASE_ID_BY_LANG:
        raise ProvenanceError(f"PROVENANCE_FACT_MISMATCH: {at}: method.json language "
                              f"{language!r} is not R or Python")
    licence = spec.get("licence")
    if not isinstance(licence, str) or not licence.strip():
        raise ProvenanceError(f"PROVENANCE_FACT_MISMATCH: {at}: method.json has no "
                              "non-empty 'licence'")
    dockerfile = git.blob(commit, f"{folder}/Dockerfile")
    if dockerfile is None:
        raise ProvenanceError(f"PROVENANCE_METHOD_NOT_IN_COMMIT: {at} has no Dockerfile")
    try:
        base_ref, key = _parse_from(dockerfile.decode("utf-8", "replace"), f"{at}/Dockerfile")
    except BuildError as e:
        raise ProvenanceError(f"PROVENANCE_FACT_MISMATCH: {e}") from e
    if BASE_LANG_BY_KEY[key] != language:
        raise ProvenanceError(
            f"PROVENANCE_FACT_MISMATCH: {at}: method.json language {language!r} "
            f"does not match its FROM base {base_ref!r}")
    runs = [r for r in ("run.py", "run.R") if git.blob(commit, f"{folder}/{r}") is not None]
    if len(runs) != 1:
        raise ProvenanceError(
            f"PROVENANCE_FACT_MISMATCH: {at} has {' and '.join(runs) or 'no run.py or run.R'}; "
            "the wrapper hash convention needs exactly one (design §2.2)")
    run_file = runs[0]
    wrapper = HASH(mj + git.blob(commit, f"{folder}/{run_file}")).hexdigest()
    gate_raw = git.blob(commit, f"gates/{eid}.json")
    try:
        gate = json.loads(gate_raw) if gate_raw is not None else None
    except ValueError:
        gate = None
    return {
        "commit": commit,
        "source_revision": commit[:12],
        "source_tree": tree,
        "version": version,
        "language": language,
        "licence": licence,
        "base_ref": base_ref,
        "contract": base_ref.rsplit(":", 1)[1],
        "run_file": run_file,
        "wrapper_code_sha256": wrapper,
        "gated": isinstance(gate, dict) and gate.get("pass") is True,
    }


def gated_method_ids(git: Git, commit: str) -> list[str]:
    """The method folders of `commit` whose gates/<id>.json passed — every
    runnable method of a full build (DEC-8), with no index.json."""
    ids = []
    for eid in git.names(commit, "methods"):
        raw = git.blob(commit, f"gates/{eid}.json")
        try:
            gate = json.loads(raw) if raw is not None else None
        except ValueError:
            gate = None
        if isinstance(gate, dict) and gate.get("pass") is True:
            ids.append(eid)
    return ids


def prepare_method_source(methods_dir: str, eid: str, src_root: str | None) -> dict:
    """The committed folder a build uses (AUDIT P7): refuses a method whose
    folder is not in HEAD (an untracked folder), whose folder or gate file has
    uncommitted changes or untracked files, or that has not passed its gate
    at HEAD; then reads its facts at HEAD and, unless `src_root` is None (a
    dry run), exports the folder with `git archive` into
    <src_root>/methods/<id>: the build context is exactly the committed bytes
    (no ignored or stray file). Returns the facts plus `dir` (the export)."""
    if not ENV_ID_RE.match(eid):
        raise BuildError(f"method id {eid!r} is not a valid env id (env_id.rs grammar); "
                         "it cannot have a layer")
    git = methods_git(methods_dir)
    head = git.commit("HEAD")
    if head is None:
        raise BuildError(f"the methods dir {methods_dir} has no HEAD commit")
    folder = f"methods/{eid}"
    if git.tree(head, folder) is None:
        raise BuildError(
            f"BUILD_METHOD_NOT_IN_COMMIT: method {eid}: {folder} is not in HEAD "
            f"({head[:12]}) of {methods_dir} — commit the method before building it "
            "(a layer from an untracked folder has no provenance)")
    dirty = git.dirty(folder, f"gates/{eid}.json")
    if dirty:
        raise BuildError(
            f"BUILD_FOLDER_DIRTY: method {eid}: uncommitted changes or untracked "
            f"files at HEAD {head[:12]} — commit or remove them first (the layer "
            "is built from the committed folder):\n  " + "\n  ".join(dirty))
    try:
        facts = method_facts_at(git, head, eid)
    except ProvenanceError as e:
        raise BuildError(f"method {eid}: {e}") from e
    if not facts["gated"]:
        raise BuildError(
            f"BUILD_NOT_GATED: method {eid} is not runnable at HEAD {head[:12]}: "
            f"gates/{eid}.json is missing or does not pass (DEC-8: exactly the "
            "runnable methods get a layer)")
    facts["dir"] = None
    if src_root is not None:
        if os.path.lexists(src_root):
            shutil.rmtree(src_root)
        os.makedirs(src_root)
        tar_path = src_root + ".tar"
        git.archive(head, folder, tar_path)
        extract_tar(tar_path, src_root)
        os.unlink(tar_path)
        facts["dir"] = os.path.join(src_root, "methods", eid)
    return facts


def method_folder(method_dir: str, eid: str) -> dict:
    """DEC-8: a runnable method whose folder is incomplete is a hard error
    naming the id, never a silent skip."""
    d = method_dir
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


def load_base_pins(path: str) -> dict[tuple[str, str], dict]:
    """The bases a list pins, by (base_id, arch): the Docker base image
    (source_ref + source_digest) every layer of that language and arch must
    be built on. A list without `bases` pins nothing."""
    try:
        with open(path) as f:
            doc = json.load(f)
    except (OSError, ValueError) as e:
        raise SystemExit(f"--base-pins {path}: cannot read the list: {e}") from e
    pins = {}
    for b in (doc.get("bases") or []) if isinstance(doc, dict) else []:
        if isinstance(b, dict) and b.get("base_id") and b.get("arch"):
            pins[(b["base_id"], b["arch"])] = {"source_ref": b.get("source_ref"),
                                               "source_digest": b.get("source_digest")}
    return pins


def _has_digest(ref: str, repo: str, digest: str) -> bool:
    """Whether the local image `ref` is the image `repo@digest`."""
    return f"{repo}@{digest}" in image_repo_digests(ref)


def resolve_pinned_base(from_ref: str, pin: dict | None, base_key: str,
                        pins_path: str) -> dict:
    """The base a one-method build uses (item 4 of the per-method plan): the
    Docker image the current list pins, by digest, from THIS machine's image
    store. The moving `:<contract>` tag is used only when it already names the
    pinned digest; otherwise a local `<repo>@<digest>` image is tagged as the
    FROM ref. Nothing is pulled (the base images are not published) and
    nothing is rebuilt (a rebuilt base has another digest): a base image moves
    between machines by `docker save` / `docker load`, its digest checked
    after the load."""
    if pin is None:
        raise BuildError(
            f"BUILD_BASE_NOT_PINNED: {pins_path} pins no {base_key} base, so there "
            "is no base to build this layer on; start a base batch with --new-base "
            "(the base and every layer on it), or pass --base-pins <list>")
    if from_ref != pin.get("source_ref"):
        raise BuildError(
            f"BUILD_FROM_NOT_PINNED: the Dockerfile starts FROM {from_ref}, but "
            f"{pins_path} pins {base_key} to {pin.get('source_ref')}; a layer on "
            "another base image needs a base batch (--new-base)")
    digest = pin.get("source_digest") or ""
    if not re.match(r"^sha256:[0-9a-f]{64}$", digest):
        raise BuildError(f"BUILD_BASE_NOT_PINNED: {pins_path} pins {base_key} to "
                         f"{digest!r}, not sha256:<64 hex>")
    repo = from_ref.rsplit(":", 1)[0]
    by_digest = f"{repo}@{digest}"
    source = "local"
    if not (image_exists(from_ref) and _has_digest(from_ref, repo, digest)):
        if not image_exists(by_digest):
            raise BuildError(
                f"BUILD_BASE_UNAVAILABLE: the pinned base image {by_digest} is not "
                "on this machine. Build the method on the machine that holds it, or "
                "move the image here with `docker save` / `docker load` and check its "
                "digest after the load. The generator never pulls a base (the base "
                "images are not published) and never rebuilds one (a rebuilt base "
                "has another digest, so its layers would not pair with the list).")
        docker("tag", by_digest, from_ref)
        source = "local-by-digest"
        if not _has_digest(from_ref, repo, digest):
            raise BuildError(f"BUILD_BASE_UNAVAILABLE: tagged {by_digest} as {from_ref}, "
                             "but the tag does not name that digest")
    return {"ref": from_ref, "digest": digest, "source": source,
            "digest_source": "repo_digests", "legacy_dir": None}


def assert_base_unchanged(from_ref: str, digest: str) -> None:
    """After the method build: the FROM tag must still name the pinned image
    (a concurrent retag would have changed the base under the build)."""
    repo = from_ref.rsplit(":", 1)[0]
    if not _has_digest(from_ref, repo, digest):
        raise BuildError(
            f"BUILD_BASE_MOVED: {from_ref} no longer names the pinned {digest} after "
            "the build (another process retagged it); the layer is not recorded — "
            "build again")


def base_cache_key(base_digest: str | None, arch: str) -> str:
    return f"{base_digest[:16] if base_digest else 'no-digest'}-{arch}"


def base_cache_dirs(out: str, base_digest: str | None, arch: str) -> tuple[str, str]:
    # base-cache/, not bases/: bases/ holds only staged base artifacts, so its
    # loader can refuse any dir without a record (like layers/).
    root = os.path.join(out, "base-cache", base_cache_key(base_digest, arch))
    return root, os.path.join(root, "rootfs")


def load_or_build_base_index(out: str, base_digest: str | None, arch: str,
                             base_rootfs: str) -> dict[str, tuple[int, str]]:
    path = os.path.join(out, "base-cache", base_cache_key(base_digest, arch),
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

def build_one(eid: str, args) -> dict:
    """Build + stage one method layer; returns the artifact record. Every
    refusal propagates as an exception naming the method; the driver stops —
    no silent skip of a runnable method (DEC-8).

    The source is the method's committed folder at the methods HEAD
    (prepare_method_source: refused when dirty, untracked or not gated), and
    every fact the record carries comes from that folder: the version and
    language from method.json, the base ref and the contract from the
    Dockerfile's FROM. The base is the image the current list pins
    (resolve_pinned_base) unless --new-base starts a base batch.
    """
    work = os.path.join(args.out, "work", f"{eid}-{args.arch}")
    src = prepare_method_source(args.methods_dir, eid,
                                None if args.dry_run else os.path.join(work, "src"))
    language, version = src["language"], src["version"]
    base_ref = src["base_ref"]
    base_id = BASE_ID_BY_LANG[language]

    print(f"\n=== {eid} ({language}, {version}, {src['source_revision']}) ===")

    if args.dry_run:
        tag = METHOD_IMAGE_TAG.format(env_id=eid, arch=args.arch)
        print(f"+ git archive {src['source_revision']} methods/{eid} -> the build context")
        if args.new_base:
            print(f"+ base {base_ref}: local -> pull -> benchmark tree (--new-base)")
        else:
            print(f"+ base {base_ref}: the local image at the digest {args.base_pins} pins")
        print("+ docker build --platform linux/%s -t %s <the export>" % (args.arch, tag))
        print("+ docker create/export %s + its FROM base %s -> tar"
              % (tag, base_ref))
        print("+ delta / trim / cover / marker / modes")
        print("+ mksquashfs " + " ".join(LAYER_MKSQUASHFS_FLAGS))
        print("+ write layers/%s-%s/artifact.json" % (eid, args.arch))
        if args.new_base:
            print("+ stage bases/%s-%s/base.squashfs from the same base rootfs "
                  "(kept when already staged from the same image)"
                  % (base_id, args.arch))
        return {"env_id": eid, "dry_run": True}

    folder = method_folder(src["dir"], eid)
    if folder["wrapper"] != src["run_file"]:
        raise BuildError(f"method {eid}: the export's run file {folder['wrapper']} is not "
                         f"the commit's {src['run_file']}")

    # 1. base: the pinned image (default), or for a base batch local -> pull ->
    # benchmark-tree fallback.
    if args.new_base:
        base = resolve_base(base_ref, language, args.benchmark_dir,
                            args.arch, args.force_base_build)
    else:
        base = resolve_pinned_base(base_ref, args.pins.get((base_id, args.arch)),
                                   f"{base_id}-{args.arch}", args.base_pins)
    if not base.get("digest"):
        raise BuildError(
            f"method {eid}: no digest recorded for base {base_ref} — the "
            "pairing anchor cannot be emitted (pulled or buildx-built base "
            "required)")

    # 2. build the method image exactly as published, from the committed folder.
    tag = METHOD_IMAGE_TAG.format(env_id=eid, arch=args.arch)
    build_image(tag, folder["dir"], args.arch)
    if not args.new_base:
        assert_base_unchanged(base_ref, base["digest"])

    # 3-4. export + extract both rootfses. The base is extracted once per
    # (digest, arch) and cached under out/bases — the full run's 95 methods
    # share two base rootfses, not 95.
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
    entries = closed_cover(delta, m_root, b_root)
    layer_dir = os.path.join(args.out, "layers", f"{eid}-{args.arch}")
    layer_root = os.path.join(layer_dir, "layer")
    materialize_layer(entries, m_root, layer_root)
    if not args.no_trim:
        trim_layer(layer_root)
    # The runtime's shared rootfs mount primitive probes `usr/ present ==
    # mounted` for EVERY artifact (base AND layer) — the shipped mount_at
    # readiness wait. A code-only layer (the rule wrappers, 65 of 94) has no
    # `usr/` at all, so it would never be considered mounted and every stacked
    # run of it would refuse with ROOTFS_MOUNT_FAILED. The layer therefore
    # carries a root-level `usr/` sentinel directory: it is NEVER a
    # layer-manifest entry, never bound, carries no content (empty unless the
    # entries are under `/usr/local`), and is exactly the mount-ready marker
    # (design §5, ITEM-7 measurement — TEST-7 is the arbiter that found it).
    os.makedirs(os.path.join(layer_root, "usr"), exist_ok=True)
    check_wrapper_modes(layer_root, folder["wrapper"])
    normalize_modes(layer_root)
    emit_marker_and_manifest(layer_root, entries)
    print(f"  entries: {', '.join(entries)}")

    # 10. pack.
    os.makedirs(layer_dir, exist_ok=True)
    squashfs = os.path.join(layer_dir, "layer.squashfs")
    pack_layer(layer_root, squashfs)

    # 11. artifact record (ITEM-3 consumes this file directly).
    layer_sha256 = _sha256_of(squashfs)
    wrapper = wrapper_code_sha256(folder["dir"], folder["wrapper"])
    if wrapper != src["wrapper_code_sha256"]:
        raise BuildError(f"method {eid}: the export's wrapper hash is not the commit's")
    record = {
        "record_schema_version": RECORD_SCHEMA_VERSION,
        "generator_version": GENERATOR_VERSION,
        "env_id": eid,
        "method_id": eid,
        "method_version": version,
        "language": language,
        "arch": args.arch,
        "oci_ref": LAYER_OCI_REF,
        "tag": layer_tag(eid, version, args.arch, layer_sha256),
        "source_revision": src["source_revision"],
        "source_tree": src["source_tree"],
        "base_ref": base["ref"],
        "base_digest": base["digest"],
        "base_digest_source": base["digest_source"],
        "base_ref_source": base["source"],
        "built_image_tag": tag,
        "layer_file": "layer.squashfs",
        "layer_sha256": layer_sha256,
        "size_bytes": os.path.getsize(squashfs),
        "wrapper_code_sha256": wrapper,
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

    # 12. a base batch (--new-base): the app-side base this layer stacks on,
    # packed from the SAME base rootfs the delta used (kept when this build
    # dir already holds it). A pinned build stages none: the list's base is
    # the published one.
    if args.new_base:
        stage_base(args.out, args.arch, language, base["ref"],
                   base["digest"], base["source"], base["digest_source"], b_root)

    if not args.keep_rootfs:
        shutil.rmtree(m_root, ignore_errors=True)
        for t in (m_tar,):
            if os.path.exists(t):
                os.unlink(t)
        if os.path.isfile(b_tar) and not os.path.isfile(b_tar_cached):
            os.replace(b_tar, b_tar_cached)  # keep for the next method
        shutil.rmtree(work, ignore_errors=True)
    return record


def pack_layer(layer_root: str, squashfs: str) -> None:
    """Pack a materialized layer root into its squashfs (the OCI artifact's
    single file)."""
    _run(["mksquashfs", layer_root, squashfs, *LAYER_MKSQUASHFS_FLAGS])
    _assert_squashfs_ok(squashfs)


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


# ───────────────────────────── the base artifact ─────────────────────────────

def _resolve_in_root(root: str, rel: str) -> str | None:
    """`rel` resolved inside `root` the way the mounted base resolves it:
    every symlink is followed, and an absolute target is taken from the
    base's own root, never the host's. None when a
    component is missing or the chain does not end (40 hops)."""
    parts = [c for c in rel.split("/") if c]
    done: list[str] = []
    hops = 0
    while parts:
        comp = parts.pop(0)
        if comp == ".":
            continue
        if comp == "..":
            if done:
                done.pop()
            continue
        host = os.path.join(root, *done, comp)
        if os.path.islink(host):
            hops += 1
            if hops > 40:
                return None
            target = os.readlink(host)
            if target.startswith("/"):
                done = []
            parts = [c for c in target.split("/") if c] + parts
            continue
        if not os.path.lexists(host):
            return None
        done.append(comp)
    return os.path.join(root, *done)


def base_rootfs_problems(rootfs: str, base_id: str) -> list[str]:
    """The BASE_REQUIRED paths `rootfs` lacks (absolute spellings)."""
    missing = []
    for rel, kind in BASE_REQUIRED[base_id]:
        host = _resolve_in_root(rootfs, rel)
        ok = host is not None and (
            os.path.isdir(host) if kind == "dir" else os.path.isfile(host))
        if not ok:
            missing.append("/" + rel)
    return missing


def base_tag(base_id: str, contract: str, arch: str,
             squashfs_sha256: str) -> str:
    """The base's immutable tag in the one base package: one tag per
    distinct base file."""
    return f"{base_id}-{contract}-{arch}-{squashfs_sha256[:12]}"


def legacy_base_address(base_id: str, contract: str, arch: str,
                        squashfs_sha256: str) -> tuple[str, str]:
    """The (oci_ref, tag) a generator before 0.4.0 wrote into a base record:
    one package per base. Accepted ONLY in a staged record, like
    legacy_layer_address."""
    return (f"{BASE_OCI_REF}/{base_id}",
            f"{contract}-{arch}-{squashfs_sha256[:12]}")


def pack_base(rootfs: str, base_dir: str, *, base_id: str, arch: str,
              source_ref: str, source_digest: str, source_ref_source: str,
              source_digest_source: str) -> dict:
    """Check + pack one base rootfs into <base_dir>/base.squashfs and write
    its record. The rootfs is only read (mksquashfs never writes its input),
    so the delta cache it comes from stays intact."""
    m = BASE_REF_RE.match(source_ref)
    if not m or BASE_ID_BY_LANG[BASE_LANG_BY_KEY[m.group(1)]] != base_id:
        raise BuildError(f"base {base_id}-{arch}: source {source_ref!r} is not "
                         f"the txresbench-base image of {base_id}")
    contract = m.group(2)
    if not re.match(r"^sha256:[0-9a-f]{64}$", source_digest or ""):
        raise BuildError(f"base {base_id}-{arch}: source digest "
                         f"{source_digest!r} is not sha256:<64 hex>")
    problems = base_rootfs_problems(rootfs, base_id)
    if problems:
        raise BuildError(
            f"base {base_id}-{arch}: the rootfs of {source_ref} lacks "
            f"{', '.join(problems)} — the stacked run needs them (the layer "
            "mount point and the sandbox's prlimit + bash); fix the base "
            "recipe, never the packed file")
    os.makedirs(base_dir, exist_ok=True)
    out = os.path.join(base_dir, BASE_FILE)
    tmp = out + ".tmp"
    if os.path.exists(tmp):
        os.unlink(tmp)
    _run(["mksquashfs", rootfs, tmp, *BASE_MKSQUASHFS_FLAGS])
    os.replace(tmp, out)
    _assert_squashfs_ok(out)
    sha = _sha256_of(out)
    record = {
        "record_schema_version": 1,
        "kind": "base",
        "generator_version": GENERATOR_VERSION,
        "base_id": base_id,
        "arch": arch,
        "contract": contract,
        "oci_ref": BASE_OCI_REF,
        "tag": base_tag(base_id, contract, arch, sha),
        "base_file": BASE_FILE,
        "squashfs_sha256": sha,
        "size_bytes": os.path.getsize(out),
        "source_ref": source_ref,
        "source_digest": source_digest,
        "source_ref_source": source_ref_source,
        "source_digest_source": source_digest_source,
    }
    rec_tmp = os.path.join(base_dir, "artifact.json.tmp")
    with open(rec_tmp, "w") as f:
        json.dump(record, f, indent=2, sort_keys=True)
        f.write("\n")
    os.replace(rec_tmp, os.path.join(base_dir, "artifact.json"))
    print(f"  base: {base_id}-{arch} {record['size_bytes']:,} bytes, "
          f"sha256 {sha[:16]}…, tag {record['tag']}")
    return record


def stage_base(out: str, arch: str, language: str, source_ref: str,
               source_digest: str, source_ref_source: str,
               source_digest_source: str, rootfs: str) -> dict:
    """Stage the base of `language` at `arch` in the build dir, once: an
    existing record from the same image whose file still matches is kept;
    one from ANOTHER image is refused (a build dir pairs every layer of a
    language and arch with one base)."""
    base_id = BASE_ID_BY_LANG[language]
    base_dir = os.path.join(out, "bases", f"{base_id}-{arch}")
    rec_path = os.path.join(base_dir, "artifact.json")
    if os.path.isfile(rec_path):
        with open(rec_path) as f:
            rec = json.load(f)
        if rec.get("source_digest") != source_digest:
            raise BuildError(
                f"{base_dir} holds {base_id}-{arch} packed from "
                f"{rec.get('source_digest')}, but this layer was built on "
                f"{source_digest}: one base per language and arch per build "
                "dir — use a new --out, or rebuild the other layers on this base")
        f_path = os.path.join(base_dir, rec.get("base_file") or BASE_FILE)
        if os.path.isfile(f_path) and _sha256_of(f_path) == rec.get("squashfs_sha256"):
            return rec
        print(f"info: {base_dir}: the staged file does not match its record; "
              "packing again", file=sys.stderr)
    return pack_base(rootfs, base_dir, base_id=base_id, arch=arch,
                     source_ref=source_ref, source_digest=source_digest,
                     source_ref_source=source_ref_source,
                     source_digest_source=source_digest_source)


def stage_bases_for_records(out: str, arch: str, dry_run: bool) -> int:
    """--stage-bases: stage the base of every language the `arch` layer
    records under <out>/layers use, without building anything. The base
    rootfs comes from the delta cache, or from the LOCAL image when its
    digest is the records' base_digest; it is never pulled or rebuilt (a
    rebuilt base has another digest and would not pair with the layers)."""
    records = [r for r in load_staged_records(out) if r.get("arch") == arch]
    if not records:
        print(f"stage-bases: no {arch} layer records under {out}/layers",
              file=sys.stderr)
        return 1
    by_lang: dict[str, set] = {}
    first: dict[str, dict] = {}
    for r in records:
        lang = r.get("language")
        if lang not in BASE_ID_BY_LANG:
            raise BuildError(f"record {_ref_of_record(r)}: language {lang!r}")
        by_lang.setdefault(lang, set()).add((r.get("base_ref"), r.get("base_digest")))
        first.setdefault(lang, r)
    for lang in sorted(by_lang):
        pairs = by_lang[lang]
        if len(pairs) != 1:
            raise BuildError(
                f"the {lang} {arch} layers under {out} were built on different "
                f"base images ({sorted(pairs)}); one base per language and arch "
                "per build dir")
        ref, digest = next(iter(pairs))
        rec = first[lang]
        print(f"=== {BASE_ID_BY_LANG[lang]}-{arch}: from {ref} @ {digest}")
        cache, rootfs = base_cache_dirs(out, digest, arch)
        if dry_run:
            print(f"+ pack {rootfs if os.path.isdir(rootfs) else ref} -> "
                  f"bases/{BASE_ID_BY_LANG[lang]}-{arch}/base.squashfs")
            continue
        if not os.path.isdir(rootfs):
            if not image_exists(ref):
                raise BuildError(
                    f"{ref} is neither cached under {cache} nor a local image; "
                    "stage the base where the layers were built")
            got = pick_digest(image_repo_digests(ref), ref)
            if got != digest:
                raise BuildError(
                    f"the local {ref} is {got}, but the layers were built on "
                    f"{digest}: that image is gone — rebuild the layers and the "
                    "base together")
            os.makedirs(cache, exist_ok=True)
            tar = os.path.join(cache, "base-rootfs.tar")
            export_rootfs(ref, tar)
            extract_tar(tar, rootfs)
        stage_base(out, arch, lang, ref, digest,
                   rec.get("base_ref_source") or "local",
                   rec.get("base_digest_source") or "repo_digests", rootfs)
    return 0


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
        if not isinstance(rec, dict) or rec.get("record_schema_version") not in RECORD_SCHEMA_VERSIONS:
            raise SystemExit(
                f"{rec_path} is not a record_schema_version 1 or 2 artifact "
                f"record (got {rec.get('record_schema_version') if isinstance(rec, dict) else rec!r})"
                " — rebuild with the current generator")
        records.append(rec)
    records.sort(key=lambda r: (r.get("env_id", ""), r.get("arch", "")))
    return records


def load_staged_bases(records_dir: str) -> list[dict]:
    """Every staged base record under <records_dir>/bases, sorted by
    (base_id, arch). As strict as load_staged_records: a dir that is not
    <base-py|base-r>-<arch>, or that has no record, is refused by name (the
    rootfs cache lives under base-cache/, so nothing else belongs here)."""
    bases = os.path.join(records_dir, "bases")
    if not os.path.isdir(bases):
        return []
    out: list[dict] = []
    for name in sorted(os.listdir(bases)):
        d = os.path.join(bases, name)
        if not os.path.isdir(d):
            continue
        m = BASE_DIR_RE.match(name)
        if not m:
            raise SystemExit(
                f"{d} is not a staged base dir (<base-py|base-r>-<arch>); the "
                "base rootfs cache lives under base-cache/ — move an older "
                "build dir's bases/<digest>-<arch> cache there")
        rec_path = os.path.join(d, "artifact.json")
        if not os.path.isfile(rec_path):
            raise SystemExit(f"staged base dir {d} has no artifact.json")
        with open(rec_path) as f:
            try:
                rec = json.load(f)
            except json.JSONDecodeError as e:
                raise SystemExit(f"{rec_path} is not valid JSON: {e}") from e
        if (not isinstance(rec, dict) or rec.get("record_schema_version") != 1
                or rec.get("kind") != "base"):
            raise SystemExit(f"{rec_path} is not a record_schema_version 1 base "
                             "record — restage with the current generator")
        if (rec.get("base_id"), rec.get("arch")) != (m.group(1), m.group(2)):
            raise SystemExit(f"{rec_path} records {rec.get('base_id')}-"
                             f"{rec.get('arch')}, not its dir {name}")
        out.append(rec)
    return out


def validate_base_record(rec: dict) -> None:
    """Writer-side checks of one base record (the guard and the app loader
    re-check the emitted manifest); each refusal names the base."""
    base_id, arch = rec.get("base_id", ""), rec.get("arch", "")
    ref = f"{base_id}-{arch}"
    if base_id not in BASE_ID_BY_LANG.values():
        raise SystemExit(f"base {ref}: base_id is not base-py or base-r")
    if arch not in ("amd64", "arm64"):
        raise SystemExit(f"base {ref}: arch not in amd64/arm64")
    sha = rec.get("squashfs_sha256", "")
    if not re.match(r"^[0-9a-f]{64}$", sha):
        raise SystemExit(f"base {ref}: squashfs_sha256 is not 64 lowercase hex")
    if not isinstance(rec.get("size_bytes"), int) or rec["size_bytes"] < 1:
        raise SystemExit(f"base {ref}: size_bytes is not a positive integer")
    if rec.get("base_file") != BASE_FILE:
        raise SystemExit(f"base {ref}: base_file is not {BASE_FILE}")
    contract = rec.get("contract", "")
    if not CONTRACT_RE.match(contract):
        raise SystemExit(f"base {ref}: contract {contract!r} is not X.Y")
    # The record's own address: the current one-package form, or the form a
    # generator before 0.4.0 wrote (the writer emits the current form either
    # way); anything else is not this base's address.
    current = (BASE_OCI_REF, base_tag(base_id, contract, arch, sha))
    legacy = legacy_base_address(base_id, contract, arch, sha)
    got = (rec.get("oci_ref"), rec.get("tag"))
    if got not in (current, legacy):
        raise SystemExit(
            f"base {ref}: record oci_ref/tag {got[0]!r} / {got[1]!r} is neither "
            f"{current[0]}:{current[1]} nor the pre-0.4.0 {legacy[0]}:{legacy[1]}")
    m = BASE_REF_RE.match(rec.get("source_ref", ""))
    if (not m or BASE_ID_BY_LANG[BASE_LANG_BY_KEY[m.group(1)]] != base_id
            or m.group(2) != contract):
        raise SystemExit(f"base {ref}: source_ref {rec.get('source_ref')!r} is "
                         f"not the txresbench-base image of {base_id} at {contract}")
    if not re.match(r"^sha256:[0-9a-f]{64}$", rec.get("source_digest", "")):
        raise SystemExit(f"base {ref}: source_digest is not sha256:<64 hex>")


def oci_base_manifest_bytes(rec: dict) -> bytes:
    """The EXACT OCI artifact manifest bytes of a base (design §6.3): the
    layer construction of §6.1 with the base's artifact type, its single
    file `base.squashfs`, and the base's annotations — the §7 pairing anchor
    `com.txr.trimmed-from-digest` among them. The manifest's `bases[].digest`
    is sha256 of THESE bytes; the publisher pushes them verbatim."""
    manifest = {
        "schemaVersion": 2,
        "mediaType": OCI_MANIFEST_MEDIATYPE,
        "artifactType": BASE_ARTIFACT_TYPE,
        "config": {
            "mediaType": "application/vnd.oci.empty.v1+json",
            "digest": OCI_EMPTY_CONFIG_DIGEST,
            "size": OCI_EMPTY_CONFIG_SIZE,
        },
        "layers": [
            {
                "mediaType": BASE_ARTIFACT_TYPE,
                "digest": "sha256:" + rec["squashfs_sha256"],
                "size": rec["size_bytes"],
                "annotations": {"org.opencontainers.image.title": rec["base_file"]},
            }
        ],
        "annotations": {
            "org.opencontainers.image.source": BASE_SOURCE_URL,
            "com.txr.base_id": rec["base_id"],
            "com.txr.arch": rec["arch"],
            "com.txr.contract": rec["contract"],
            "com.txr.trimmed-from-ref": rec["source_ref"],
            "com.txr.trimmed-from-digest": rec["source_digest"],
            "com.txr.base_sha256": rec["squashfs_sha256"],
        },
    }
    return json.dumps(manifest, separators=(",", ":"), ensure_ascii=False).encode()


#: The emitted `bases[]` record's fields, in the schema's order.
BASE_ENTRY_FIELDS = ("base_id", "arch", "oci_ref", "tag", "digest",
                     "squashfs_sha256", "size_bytes", "source_ref",
                     "source_digest", "contract")


def _ref_of_record(rec: dict) -> str:
    return f"{rec.get('env_id', '?')}-{rec.get('arch', '?')}"


def validate_record_and_entry(rec: dict, entry: dict) -> None:
    """Writer-side structural checks; each refusal names the record.

    The ITEM-4 guard re-validates the COMMITTED file; the writer validates
    the same facts at assembly time so a bad record cannot produce a bad
    manifest that a later guard round then has to explain. Every check is
    a hard error (never a normalize-and-proceed): a value the writer
    silently repairs would not regenerate on the next run and would break
    byte parity. (The method facts — gate, version, language, FROM, wrapper,
    folder tree — are checked against git in entry_from_record BEFORE this.)
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
    if not METHOD_VERSION_RE.match(version):
        raise SystemExit(f"record {ref}: method_version {version!r} is not X.Y.Z with "
                         "an optional -/. suffix (the registry tag needs it)")
    if not BASE_REF_RE.match(entry["base_ref"]):
        raise SystemExit(f"record {ref}: base_ref {entry['base_ref']!r} is not a "
                         "ghcr.io/tinnlab/txresbench-base-(r|py):<contract> ref")
    for field, pat in (("base_digest", r"^sha256:[0-9a-f]{64}$"),
                       ("layer_sha256", r"^[0-9a-f]{64}$"),
                       ("wrapper_code_sha256", r"^[0-9a-f]{64}$")):
        if not re.match(pat, entry[field]):
            raise SystemExit(f"record {ref}: {field} {entry[field]!r} is not the "
                             "required hex/digest shape")
    # The address (after layer_sha256's shape: the tag carries its first 12
    # hex).
    if entry["oci_ref"] != LAYER_OCI_REF:
        raise SystemExit(f"record {ref}: oci_ref {entry['oci_ref']!r} is not "
                         f"{LAYER_OCI_REF} (the one layer package)")
    if entry["tag"] != layer_tag(entry["env_id"], version, arch,
                                 entry["layer_sha256"]):
        raise SystemExit(
            f"record {ref}: tag {entry['tag']!r} != "
            "'<env_id>-<method_version>-<arch>-<first 12 hex of layer_sha256>' "
            f"(DEC-2; got version {version!r})")
    if not OCI_TAG_RE.match(entry["tag"]):
        raise SystemExit(
            f"record {ref}: tag {entry['tag']!r} is not a valid OCI tag (at "
            "most 128 characters of [A-Za-z0-9_.-], not starting with . or -)")
    # The record's own address: the current form, or the form a generator
    # before 0.4.0 wrote (one package per method, no hash in the tag); the
    # entry carries the current form either way. Anything else — the
    # one-package form without the hash included — is not this record's
    # address.
    legacy = legacy_layer_address(entry["env_id"], version, arch)
    got = (rec.get("oci_ref"), rec.get("tag"))
    if got not in ((entry["oci_ref"], entry["tag"]), legacy):
        raise SystemExit(
            f"record {ref}: record oci_ref/tag {got[0]!r} / {got[1]!r} is "
            f"neither {entry['oci_ref']}:{entry['tag']} nor the pre-0.4.0 "
            f"{legacy[0]}:{legacy[1]}")
    if not isinstance(entry["size_bytes"], int) or entry["size_bytes"] < 1:
        raise SystemExit(f"record {ref}: size_bytes {entry['size_bytes']!r} is "
                         "not a positive integer")
    if entry["language"] not in ("R", "Python"):
        raise SystemExit(f"record {ref}: language {entry['language']!r} not in R/Python")
    base_contract = entry["base_ref"].rsplit(":", 1)[1]
    if entry["contract"] != base_contract:
        raise SystemExit(
            f"record {ref}: contract {entry['contract']!r} != the base "
            f"tag contract {base_contract!r} of {entry['base_ref']} — a layer "
            "computed against one contract cannot be declared as another")
    if not CONTRACT_RE.match(entry["contract"]):
        raise SystemExit(f"record {ref}: contract {entry['contract']!r} is "
                         "not an X.Y version")
    if entry["layer_schema"] != LAYER_SCHEMA_VERSION:
        raise SystemExit(f"record {ref}: layer_schema {entry['layer_schema']!r} != "
                         f"{LAYER_SCHEMA_VERSION} (DEC-11)")
    if not entry["licence"].strip():
        raise SystemExit(f"record {ref}: method.json licence is empty (minLength 1)")
    if not GENERATOR_VERSION_RE.match(str(entry["generator_version"])):
        raise SystemExit(f"record {ref}: generator_version "
                         f"{entry['generator_version']!r} is not X.Y.Z")


def entry_from_record(rec: dict, git: Git) -> dict:
    """One manifest entry from one staged record. Every method fact is read
    from git at the record's OWN commit (`source_revision`) and must agree
    with what the record measured: the gate (DEC-8), method.json's version
    and language, the Dockerfile's FROM, the run file and the wrapper hash
    (the layer's /code is that commit's method.json + run file), and for a
    record_schema_version 2 record the folder's git tree. The licence and
    the contract come from that commit, never from the methods HEAD or the
    generated index.json (AUDIT P7). A record from a generator before 0.5.0
    (record_schema_version 1) has no tree: it is taken from git, and the
    wrapper check is what ties the record to that commit."""
    ref = _ref_of_record(rec)
    eid = rec.get("env_id", "")
    if not eid or not ENV_ID_RE.match(eid):
        raise SystemExit(f"record {ref}: env_id missing/invalid")
    rev = str(rec.get("source_revision") or "")
    if not SOURCE_REVISION_RE.match(rev):
        raise SystemExit(f"record {ref}: source_revision {rev!r} is not the 12-hex "
                         "methods commit")
    commit = git.commit(rev)
    if commit is None:
        raise SystemExit(
            f"record {ref}: PROVENANCE_COMMIT_UNKNOWN: commit {rev} is not in the "
            f"methods repository {git.repo} (fetch it, or rebuild the layer)")
    try:
        facts = method_facts_at(git, commit, eid)
    except ProvenanceError as e:
        raise SystemExit(f"record {ref}: {e}") from e
    if not facts["gated"]:
        raise SystemExit(
            f"record {ref}: PROVENANCE_NOT_GATED: method {eid!r} is not runnable "
            f"at {rev}: gates/{eid}.json is missing or does not pass (DEC-8: exactly "
            "the runnable methods get a layer)")
    version = rec.get("method_version", "")
    if version != facts["version"]:
        raise SystemExit(
            f"record {ref}: PROVENANCE_VERSION_MISMATCH: the record says {version!r}, "
            f"methods/{eid}/method.json at {rev} says {facts['version']!r}")
    for field in ("language", "base_ref", "run_file"):
        if rec.get(field) != facts[field]:
            raise SystemExit(
                f"record {ref}: PROVENANCE_FACT_MISMATCH: record {field} "
                f"{rec.get(field)!r} != {facts[field]!r} from methods/{eid} at {rev}")
    if rec.get("wrapper_code_sha256") != facts["wrapper_code_sha256"]:
        raise SystemExit(
            f"record {ref}: PROVENANCE_WRAPPER_MISMATCH: sha256(method.json + "
            f"{facts['run_file']}) at {rev} is {facts['wrapper_code_sha256']}, the "
            f"record's is {rec.get('wrapper_code_sha256')} — the layer's /code is "
            "not that commit's")
    if rec.get("record_schema_version", 1) >= 2 and rec.get("source_tree") != facts["source_tree"]:
        raise SystemExit(
            f"record {ref}: PROVENANCE_TREE_MISMATCH: record source_tree "
            f"{rec.get('source_tree')!r} != the git tree of methods/{eid} at {rev} "
            f"({facts['source_tree']})")
    contract = facts["contract"]
    entry = {
        "env_id": eid,
        "method_id": rec.get("method_id", eid),
        "method_version": version,
        "language": rec.get("language", ""),
        "arch": rec.get("arch", ""),
        # The address is derived from the record's identity, never
        # copied: a record from a generator before 0.4.0 carries the
        # per-method-package form (validate_record_and_entry checks it).
        "oci_ref": LAYER_OCI_REF,
        "tag": layer_tag(eid, version, rec.get("arch", ""),
                         str(rec.get("layer_sha256", ""))),
        "digest": "sha256:" + HASH(oci_artifact_manifest_bytes(rec, contract)).hexdigest(),
        "layer_sha256": rec.get("layer_sha256", ""),
        "size_bytes": rec.get("size_bytes", 0),
        "base_ref": rec.get("base_ref", ""),
        "base_digest": rec.get("base_digest", ""),
        "contract": contract,
        "licence": facts["licence"],
        "wrapper_code_sha256": rec.get("wrapper_code_sha256", ""),
        "layer_schema": rec.get("layer_schema", -1),
        "source_revision": rev,
        "source_tree": facts["source_tree"],
        "generator_version": rec.get("generator_version", ""),
    }
    validate_record_and_entry(rec, entry)
    return entry


def oci_artifact_manifest_bytes(rec: dict, contract: str) -> bytes:
    """The EXACT OCI artifact manifest bytes ITEM-5's publisher must push
    (design §6): the manifest `digest` recorded in the committed file is
    sha256 of THESE bytes, so the construction is pinned here once and the
    publisher's verify (oras resolve == digest) is the runtime-visible seam
    that closes the loop when oras is at hand.

    The shape mirrors what `oras push --artifact-type <t> <ref>:<tag>
    layer.squashfs:<t>` stores (the publisher's own invocation
    shape): artifactType = the artifact type, the single layer's mediaType
    = the artifact type (the file is the layer, not a tar), config = the
    OCI empty JSON, the layer descriptor carries the file title annotation
    (oras's file-push convention). The annotations name the layer and its
    file only — never the methods commit or the base image the layer was
    built at: those are per-entry provenance in the list (source_revision,
    base_ref, base_digest). So the same layer file always gives the same
    bytes, digest and tag: a rebuild of an unchanged method at a later commit,
    or over a new base image, is the artifact already published (a no-op
    publish), never a second set of bytes under one tag. Key order is the OCI
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
            "com.txr.method_id": rec["method_id"],
            "com.txr.method_version": rec["method_version"],
            "com.txr.language": rec["language"],
            "com.txr.arch": rec["arch"],
            "com.txr.contract": contract,
            "com.txr.layer_sha256": rec["layer_sha256"],
            "com.txr.layer_schema": str(rec["layer_schema"]),
        },
    }
    return json.dumps(manifest, separators=(",", ":"), ensure_ascii=False).encode()


def emitted_base(b: dict) -> dict:
    """The `bases[]` record of one staged base (schema field order), at the
    current address whatever form the staged record carries
    (validate_base_record accepted the current or the pre-0.4.0 one)."""
    emitted = {f: b[f] for f in BASE_ENTRY_FIELDS if f not in ("oci_ref", "tag", "digest")}
    emitted["oci_ref"] = BASE_OCI_REF
    emitted["tag"] = base_tag(b["base_id"], b["contract"], b["arch"], b["squashfs_sha256"])
    emitted["digest"] = "sha256:" + HASH(oci_base_manifest_bytes(b)).hexdigest()
    return {f: emitted[f] for f in BASE_ENTRY_FIELDS}


def parse_key(key: str, what: str) -> tuple[str, str]:
    """`<id>-<arch>` (an env id or a base id, then amd64|arm64)."""
    head, _, arch = key.rpartition("-")
    if not head or arch not in ("amd64", "arm64") or not ENV_ID_RE.match(head):
        raise SystemExit(f"{what} {key!r} is not <id>-<amd64|arm64>")
    return head, arch


def _key_ref(key: tuple[str, str]) -> str:
    return f"{key[0]}-{key[1]}"


def _base_key_of(entry: dict) -> tuple[str, str]:
    return BASE_ID_BY_LANG.get(entry.get("language"), "?"), entry.get("arch", "?")


def load_previous(path: str) -> dict:
    """The previous list an incremental assembly or check carries entries
    from: schema 2 with a `bases` list (an older list cannot be carried: its
    entries have no per-entry provenance — assemble the first schema 2 list
    with --full). Entries and bases are returned in the schema field order,
    values untouched, so a carried entry re-serializes to the same bytes."""
    try:
        with open(path, "rb") as f:
            doc = json.loads(f.read())
    except (OSError, ValueError) as e:
        raise SystemExit(f"--previous {path}: cannot read the list: {e}") from e
    if not isinstance(doc, dict) or doc.get("schema_version") != MANIFEST_SCHEMA_VERSION:
        got = doc.get("schema_version") if isinstance(doc, dict) else None
        raise SystemExit(
            f"ASSEMBLE_PREVIOUS_SCHEMA: --previous {path} is schema_version {got!r}; "
            f"only a schema {MANIFEST_SCHEMA_VERSION} list carries entries forward "
            "(per-entry provenance) — assemble the first one with --full")
    if not isinstance(doc.get("bases"), list):
        raise SystemExit(
            f"ASSEMBLE_PREVIOUS_NO_BASES: --previous {path} has no bases list, so it "
            "pins no base to pair new layers with — assemble with --full")
    if not CONTRACT_RE.match(str(doc.get("base_contract") or "")):
        raise SystemExit(f"--previous {path}: base_contract is not X.Y")
    envs, bases = [], []
    for i, e in enumerate(doc.get("envs") or []):
        if not isinstance(e, dict) or set(e) != set(ENV_FIELDS):
            raise SystemExit(f"--previous {path}: envs[{i}] does not carry exactly the "
                             "schema 2 entry fields")
        envs.append({f: e[f] for f in ENV_FIELDS})
    for i, b in enumerate(doc["bases"]):
        if not isinstance(b, dict) or set(b) != set(BASE_ENTRY_FIELDS):
            raise SystemExit(f"--previous {path}: bases[{i}] does not carry exactly the "
                             "base fields")
        bases.append({f: b[f] for f in BASE_ENTRY_FIELDS})
    return {"path": path, "base_contract": doc["base_contract"], "envs": envs, "bases": bases}


def assemble_manifest(records: list[dict], methods_dir: str, base_records: list[dict], *,
                      previous: dict | None = None, replace_bases: tuple = (),
                      drops: tuple = ()) -> tuple[dict, dict, dict]:
    """One manifest (schema 2) from staged records.

    --full (previous None): every entry from a record, the bases from the
    staged base records (design §7: each entry pairs with the staged base of
    its language and arch; only the bases some entry uses are emitted).

    --previous: the previous list's entries and bases are CARRIED, values
    untouched; each record's entry replaces or adds its (env_id, arch);
    `drops` (`<env_id>-<arch>`) removes carried entries. Every new entry must
    pair with the base the list pins for its language and arch — another
    image is ASSEMBLE_BASE_CHANGED. `replace_bases` (`<base_id>-<arch>`)
    takes that staged base instead (a base batch): when its source image
    changes, every carried entry on it must have been rebuilt in this batch
    or dropped (ASSEMBLE_BASE_BATCH). A base no entry uses is left out.

    Every new entry's facts are read from git at its own record's commit
    (entry_from_record); the methods repository's HEAD does not matter.
    Returns (manifest, new entries by key, summary)."""
    if previous is None and not records:
        raise SystemExit(
            "no staged records to assemble (the manifest is never written from "
            "an empty staging dir outside the ITEM-1 seed path)")
    new: dict[tuple[str, str], dict] = {}
    if records:
        git = methods_git(methods_dir)
        for rec in records:
            entry = entry_from_record(rec, git)
            key = (entry["env_id"], entry["arch"])
            if key in new:
                raise SystemExit(f"two staged records for {_key_ref(key)}")
            new[key] = entry
    staged: dict[tuple[str, str], dict] = {}
    for b in base_records:
        validate_base_record(b)
        staged[(b["base_id"], b["arch"])] = b

    summary = {"added": [], "replaced": [], "unchanged": [], "carried": [], "dropped": [],
               "bases": []}
    if previous is None:
        contract = BASE_CONTRACT
        for b in staged.values():
            if b["contract"] != contract:
                raise SystemExit(f"base {b['base_id']}-{b['arch']}: contract "
                                 f"{b['contract']!r} is not the base_contract {contract}")
        entries = dict(new)
        pool = {k: emitted_base(b) for k, b in staged.items()}
        prev_envs: dict = {}
        summary["added"] = sorted(new)
    else:
        contract = previous["base_contract"]
        prev_envs = {(e["env_id"], e["arch"]): e for e in previous["envs"]}
        drop_keys = {parse_key(d, "--drop") for d in drops}
        for k in sorted(drop_keys):
            if k not in prev_envs:
                raise SystemExit(f"ASSEMBLE_DROP_UNKNOWN: --drop {_key_ref(k)}: the previous "
                                 f"list {previous['path']} has no such entry")
            if k in new:
                raise SystemExit(f"--drop {_key_ref(k)}: a staged record rebuilds it too; "
                                 "drop it or rebuild it, not both")
        entries = {k: e for k, e in prev_envs.items() if k not in drop_keys}
        for k, e in new.items():
            if k not in prev_envs:
                summary["added"].append(k)
            elif prev_envs[k] == e:
                summary["unchanged"].append(k)
            else:
                summary["replaced"].append(k)
            entries[k] = e
        summary["carried"] = sorted(k for k in entries if k not in new)
        summary["dropped"] = sorted(drop_keys)
        pool = {(b["base_id"], b["arch"]): b for b in previous["bases"]}
        for rb in replace_bases:
            k = parse_key(rb, "--replace-base")
            if k[0] not in BASE_ID_BY_LANG.values():
                raise SystemExit(f"--replace-base {rb}: {k[0]!r} is not base-py or base-r")
            b = staged.get(k)
            if b is None:
                raise SystemExit(f"ASSEMBLE_BASE_BATCH: --replace-base {rb}: no staged base "
                                 f"{rb} under <dir>/bases")
            if b["contract"] != contract:
                raise SystemExit(f"base {rb}: contract {b['contract']!r} is not the list's "
                                 f"base_contract {contract}")
            pool[k] = emitted_base(b)
            summary["bases"].append(rb)
    for k, e in new.items():
        if e["contract"] != contract:
            raise SystemExit(
                f"record {_key_ref(k)}: ASSEMBLE_CONTRACT: contract {e['contract']!r} is not "
                f"the list's base_contract {contract!r} (one contract line per list)")

    used: set = set()
    for k in sorted(entries):
        e = entries[k]
        bk = _base_key_of(e)
        b = pool.get(bk)
        ref = _key_ref(k)
        if b is None:
            if previous is None:
                raise SystemExit(
                    f"record {ref}: no staged base {bk[0]}-{bk[1]} under "
                    "<dir>/bases — stage it (--stage-bases --out <dir> --arch "
                    f"{bk[1]}); a layer without its base cannot run")
            raise SystemExit(
                f"record {ref}: ASSEMBLE_BASE_CHANGED: the list pins no {bk[0]}-{bk[1]} base; "
                f"add it as a base batch (--replace-base {bk[0]}-{bk[1]} with that base "
                "staged under <dir>/bases)")
        for e_field, b_field in (("base_ref", "source_ref"), ("base_digest", "source_digest")):
            if e[e_field] == b[b_field]:
                continue
            if previous is None:
                raise SystemExit(
                    f"record {ref}: {e_field} {e[e_field]} != the staged "
                    f"{bk[0]}-{bk[1]}'s {b_field} {b[b_field]} — the layer was "
                    "built on another base image (design §7); rebuild the layer "
                    "and the base together")
            if k in new:
                raise SystemExit(
                    f"record {ref}: ASSEMBLE_BASE_CHANGED: {e_field} {e[e_field]} != "
                    f"{bk[0]}-{bk[1]}'s {b_field} {b[b_field]} in the list — the layer was "
                    "built on another base image (design §7); rebuild it on the pinned "
                    f"base, or start a base batch (--replace-base {bk[0]}-{bk[1]})")
            raise SystemExit(
                f"{ref}: ASSEMBLE_BASE_BATCH: the new {bk[0]}-{bk[1]} base was packed from "
                f"{b[b_field]}, but {ref}, carried from the previous list, was built on "
                f"{e[e_field]}: a base change is a batch — rebuild {ref} on the new base "
                "in this assembly, or --drop it")
        used.add(bk)
    bases = [pool[k] for k in sorted(used)]
    manifest = {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "generator_version": GENERATOR_VERSION,
        "base_contract": contract,
        "bases": bases,
        "envs": [entries[k] for k in sorted(entries)],
    }
    return manifest, new, summary


def manifest_bytes(manifest: dict) -> bytes:
    """The pinned serialization: 2-space indent, field order as emitted by
    assemble_manifest (the schema's own order), trailing newline — the same
    shape the ITEM-1 seed used, so `--check` is a byte comparison."""
    return (json.dumps(manifest, indent=2) + "\n").encode()


def _entry_difference(committed: dict, assembled: dict, fields: tuple) -> str | None:
    for field in fields:
        if committed.get(field) != assembled.get(field):
            return field
    extra = sorted(set(committed) - set(fields))
    return extra[0] if extra else None


def first_difference(committed: dict, assembled: dict) -> str | None:
    """The path of the first field where the two manifests differ (TEST-2:
    the failure names the first differing key), or None when they agree."""
    if committed.get("schema_version") != assembled.get("schema_version"):
        return "schema_version"
    for key in ("generator_version", "base_contract"):
        if committed.get(key) != assembled.get(key):
            return key
    extra = sorted(set(committed) - set(assembled))
    if extra:
        return extra[0]
    c_bases, a_bases = committed.get("bases"), assembled.get("bases")
    if not isinstance(c_bases, list) or not isinstance(a_bases, list):
        if c_bases != a_bases:
            return "bases"
    else:
        for i in range(max(len(c_bases), len(a_bases))):
            if i >= len(c_bases) or i >= len(a_bases):
                return f"bases[{i}].base_id"
            field = _entry_difference(c_bases[i], a_bases[i], BASE_ENTRY_FIELDS)
            if field:
                return f"bases[{i}].{field}"
    c_envs = committed.get("envs", [])
    a_envs = assembled.get("envs", [])
    if len(c_envs) != len(a_envs):
        c_keys = {(e.get("env_id"), e.get("arch")) for e in c_envs}
        a_keys = {(e.get("env_id"), e.get("arch")) for e in a_envs}
        missing = sorted(a_keys - c_keys)
        extra_keys = sorted(c_keys - a_keys)
        if missing:
            return f"envs[{len(c_envs)}].env_id (missing {missing[0][0]}-{missing[0][1]})"
        return f"envs[{len(c_envs)}].env_id (unexpected {extra_keys[0][0]}-{extra_keys[0][1]})"
    for i, (c, a) in enumerate(zip(c_envs, a_envs)):
        if (c.get("env_id"), c.get("arch")) != (a.get("env_id"), a.get("arch")):
            return f"envs[{i}].env_id ({c.get('env_id')} != {a.get('env_id')})"
        field = _entry_difference(c, a, ENV_FIELDS)
        if field:
            return f"envs[{i}].{field}"
    return None


def _read_committed(manifest_path: str) -> tuple[bytes, dict | None]:
    with open(manifest_path, "rb") as f:
        raw = f.read()
    try:
        doc = json.loads(raw)
    except ValueError as e:
        print(f"check: {manifest_path} is not valid JSON: {e}", file=sys.stderr)
        return raw, None
    if not isinstance(doc, dict):
        print(f"check: {manifest_path} is not a JSON object", file=sys.stderr)
        return raw, None
    return raw, doc


def _differs(path: str, committed, assembled, what: str) -> int:
    print(f"check: MANIFEST DIFFERS at {path}: committed {committed!r} != "
          f"assembled {assembled!r} ({what})", file=sys.stderr)
    print("check: regenerate with --manifest <path> (or rebuild the entry); never "
          "hand-edit (INV-5)", file=sys.stderr)
    return 1


def check_full(records: list[dict], methods_dir: str, manifest_path: str,
               base_records: list[dict]) -> int:
    """Whole-list parity (the full-rebuild mode): assemble every entry from
    the staged records (no build) and compare BYTE equality against the
    committed manifest; report the first differing key. 0 = identical, 1 =
    differ. An edited per-entry provenance field surfaces as that field
    (TEST-2: fails naming the first differing key)."""
    committed_bytes, committed = _read_committed(manifest_path)
    if committed is None:
        return 1
    if not records:
        print("check: no staged records — whole-list parity cannot be assessed",
              file=sys.stderr)
        return 1
    manifest, _new, _summary = assemble_manifest(records, methods_dir, base_records)
    if manifest_bytes(manifest) == committed_bytes:
        n = len(manifest["envs"])
        print(f"check: MANIFEST OK ({n} env entr{'y' if n == 1 else 'ies'}, every one "
              f"re-assembled from its record, generator {manifest['generator_version']})")
        return 0
    key = first_difference(committed, manifest)
    return _differs(key, _lookup(committed, key), _lookup(manifest, key),
                    f"{len(manifest['envs'])} assembled entries vs "
                    f"{len(committed.get('envs', []))} committed")


def _canonical(doc: dict) -> bytes:
    """The writer's serialization of what a schema 2 list holds (entries and
    bases in the schema field order and sorted): a list whose bytes differ
    from it was not written by the writer."""
    try:
        envs = sorted(({f: e[f] for f in ENV_FIELDS} for e in doc.get("envs") or []),
                      key=lambda e: (e["env_id"], e["arch"]))
        bases = sorted(({f: b[f] for f in BASE_ENTRY_FIELDS} for b in doc.get("bases") or []),
                       key=lambda b: (b["base_id"], b["arch"]))
    except (KeyError, TypeError):
        return b""
    return manifest_bytes({"schema_version": doc.get("schema_version"),
                           "generator_version": doc.get("generator_version"),
                           "base_contract": doc.get("base_contract"),
                           "bases": bases, "envs": envs})


def check_previous(records: list[dict], methods_dir: str, manifest_path: str,
                   base_records: list[dict], previous: dict) -> int:
    """Entry-level parity against the previous list (the one-method mode):
    an entry byte-identical to the previous list's is carried; every other
    entry must re-assemble, byte for byte, from a staged record (its facts
    read from git at its own commit); a changed base must re-assemble from a
    staged base, and when its source image changed, every entry on it must
    be one of the re-assembled ones (a base change is a batch). Entries the
    previous list has and this one lacks are printed as dropped. The file
    must be the writer's own serialization."""
    committed_bytes, committed = _read_committed(manifest_path)
    if committed is None:
        return 1
    top = {"schema_version": MANIFEST_SCHEMA_VERSION, "generator_version": GENERATOR_VERSION,
           "base_contract": previous["base_contract"]}
    for key, want in top.items():
        if committed.get(key) != want:
            return _differs(key, committed.get(key), want, "the list's top level")
    by_key = {(r.get("env_id"), r.get("arch")): r for r in records}
    p_envs = {(e["env_id"], e["arch"]): e for e in previous["envs"]}
    p_bases = {(b["base_id"], b["arch"]): b for b in previous["bases"]}
    git = None
    reassembled: set = set()
    c_envs = committed.get("envs") or []
    for i, c in enumerate(c_envs):
        key = (c.get("env_id"), c.get("arch"))
        p = p_envs.get(key)
        if p is not None and p == c:
            continue
        rec = by_key.get(key)
        if rec is None:
            why = (f"differs from the previous list at envs[{i}]."
                   f"{_entry_difference(p, c, ENV_FIELDS)}" if p is not None
                   else "is not in the previous list")
            print(f"check: CHECK_NO_RECORD: envs[{i}] {_key_ref(key)} {why}, and no staged "
                  "record re-assembles it (a carried entry is byte-identical to the "
                  f"previous list {previous['path']}; a new or changed one is checked "
                  "against its own build record)", file=sys.stderr)
            return 1
        if git is None:
            git = methods_git(methods_dir)
        assembled = entry_from_record(rec, git)
        field = _entry_difference(c, assembled, ENV_FIELDS)
        if field:
            return _differs(f"envs[{i}].{field}", c.get(field), assembled.get(field),
                            f"re-assembled from the staged record of {_key_ref(key)}")
        reassembled.add(key)
    c_keys = {(e.get("env_id"), e.get("arch")) for e in c_envs}
    dropped = sorted(k for k in p_envs if k not in c_keys)
    staged = {}
    for b in base_records:
        validate_base_record(b)
        staged[(b["base_id"], b["arch"])] = b
    c_bases = committed.get("bases")
    if not isinstance(c_bases, list):
        print("check: the list has no bases list (a schema 2 list pins its bases)",
              file=sys.stderr)
        return 1
    for i, cb in enumerate(c_bases):
        key = (cb.get("base_id"), cb.get("arch"))
        pb = p_bases.get(key)
        if pb is not None and pb == cb:
            continue
        sb = staged.get(key)
        if sb is None:
            print(f"check: CHECK_NO_RECORD: bases[{i}] {_key_ref(key)} "
                  f"{'differs from' if pb else 'is not in'} the previous list, and no "
                  "staged base under <dir>/bases re-assembles it", file=sys.stderr)
            return 1
        eb = emitted_base(sb)
        field = _entry_difference(cb, eb, BASE_ENTRY_FIELDS)
        if field:
            return _differs(f"bases[{i}].{field}", cb.get(field), eb.get(field),
                            f"re-assembled from the staged base {_key_ref(key)}")
        if pb is None or (pb["source_ref"], pb["source_digest"]) != (cb["source_ref"], cb["source_digest"]):
            for j, e in enumerate(c_envs):
                ek = (e.get("env_id"), e.get("arch"))
                if _base_key_of(e) == key and ek not in reassembled:
                    print(f"check: CHECK_BASE_BATCH: bases[{i}] {_key_ref(key)} changed its "
                          f"source image, but envs[{j}] {_key_ref(ek)} is carried from the "
                          "previous list — a base change is a batch (the base and every "
                          "layer on it)", file=sys.stderr)
                    return 1
    for j, e in enumerate(c_envs):
        b = next((x for x in c_bases if (x.get("base_id"), x.get("arch")) == _base_key_of(e)), None)
        if b is None or (e.get("base_ref"), e.get("base_digest")) != (b.get("source_ref"), b.get("source_digest")):
            print(f"check: envs[{j}] {e.get('env_id')}-{e.get('arch')} does not pair with "
                  "a base of the list (design §7)", file=sys.stderr)
            return 1
    if _canonical(committed) != committed_bytes:
        print(f"check: MANIFEST DIFFERS: {manifest_path} is not the writer's serialization "
              "of what it holds (field order, sort order or whitespace) — regenerate, "
              "never hand-edit (INV-5)", file=sys.stderr)
        return 1
    carried = len(c_envs) - len(reassembled)
    print(f"check: MANIFEST OK (against the previous list {previous['path']}: {carried} "
          f"carried byte-identical, {len(reassembled)} re-assembled from their records, "
          f"{len(dropped)} dropped)")
    for k in dropped:
        print(f"check: dropped from the previous list: {_key_ref(k)}")
    return 0


def check_entries(records: list[dict], methods_dir: str, manifest_path: str,
                  base_records: list[dict], entries: list, base_entries: list) -> int:
    """Entry-level parity of the named entries only (the publisher's own
    artifact): each must re-assemble byte for byte from its staged record
    (facts read from git at its commit) or, for a base, from its staged base
    record. No other record is needed."""
    _raw, committed = _read_committed(manifest_path)
    if committed is None:
        return 1
    by_key = {(r.get("env_id"), r.get("arch")): r for r in records}
    c_envs = {(e.get("env_id"), e.get("arch")): (i, e)
              for i, e in enumerate(committed.get("envs") or [])}
    git = None
    for raw in entries:
        key = parse_key(raw, "--entry")
        if key not in c_envs:
            print(f"check: --entry {raw}: the list has no such entry", file=sys.stderr)
            return 1
        rec = by_key.get(key)
        if rec is None:
            print(f"check: CHECK_NO_RECORD: {raw}: no staged record under <dir>/layers",
                  file=sys.stderr)
            return 1
        if git is None:
            git = methods_git(methods_dir)
        i, c = c_envs[key]
        assembled = entry_from_record(rec, git)
        field = _entry_difference(c, assembled, ENV_FIELDS)
        if field:
            return _differs(f"envs[{i}].{field}", c.get(field), assembled.get(field),
                            f"re-assembled from the staged record of {raw}")
    staged = {(b["base_id"], b["arch"]): b for b in base_records}
    c_bases = {(b.get("base_id"), b.get("arch")): (i, b)
               for i, b in enumerate(committed.get("bases") or [])}
    for raw in base_entries:
        key = parse_key(raw, "--base-entry")
        if key not in c_bases:
            print(f"check: --base-entry {raw}: the list has no such base", file=sys.stderr)
            return 1
        sb = staged.get(key)
        if sb is None:
            print(f"check: CHECK_NO_RECORD: {raw}: no staged base under <dir>/bases",
                  file=sys.stderr)
            return 1
        validate_base_record(sb)
        i, cb = c_bases[key]
        eb = emitted_base(sb)
        field = _entry_difference(cb, eb, BASE_ENTRY_FIELDS)
        if field:
            return _differs(f"bases[{i}].{field}", cb.get(field), eb.get(field),
                            f"re-assembled from the staged base {raw}")
    names = ", ".join(list(entries) + list(base_entries))
    print(f"check: ENTRY OK ({names} re-assembled from their records)")
    return 0


def check_provenance(manifest_path: str, methods_dir: str, entries: list) -> int:
    """Every entry's (or the named entries') facts against the methods
    repository at the entry's own commit: the commit exists, the folder's
    tree is the recorded one, the gate passed, and method.json's version,
    language and licence, the Dockerfile's FROM (its tag = the contract) and
    the wrapper hash are what the entry says (AUDIT P7)."""
    _raw, committed = _read_committed(manifest_path)
    if committed is None:
        return 1
    git = methods_git(methods_dir)
    envs = list(enumerate(committed.get("envs") or []))
    if entries:
        wanted = {parse_key(k, "--entry") for k in entries}
        envs = [(i, e) for i, e in envs if (e.get("env_id"), e.get("arch")) in wanted]
        found = {(e.get("env_id"), e.get("arch")) for _i, e in envs}
        missing = sorted(wanted - found)
        if missing:
            print(f"provenance: --entry {_key_ref(missing[0])}: the list has no such entry",
                  file=sys.stderr)
            return 1
    problems = []
    for i, e in envs:
        ref = f"envs[{i}] {e.get('env_id')}-{e.get('arch')}"
        rev = str(e.get("source_revision") or "")
        commit = git.commit(rev) if SOURCE_REVISION_RE.match(rev) else None
        if commit is None:
            problems.append(f"{ref}: PROVENANCE_COMMIT_UNKNOWN: commit {rev!r} is not in "
                            f"{methods_dir}")
            continue
        try:
            facts = method_facts_at(git, commit, str(e.get("env_id")))
        except ProvenanceError as ex:
            problems.append(f"{ref}: {ex}")
            continue
        if not facts["gated"]:
            problems.append(f"{ref}: PROVENANCE_NOT_GATED: gates/{e.get('env_id')}.json at "
                            f"{rev} is missing or does not pass")
        if e.get("source_tree") != facts["source_tree"]:
            problems.append(f"{ref}: PROVENANCE_TREE_MISMATCH: source_tree "
                            f"{e.get('source_tree')!r} != {facts['source_tree']} at {rev}")
        if e.get("method_version") != facts["version"]:
            problems.append(f"{ref}: PROVENANCE_VERSION_MISMATCH: the list says "
                            f"{e.get('method_version')!r}, method.json at {rev} says "
                            f"{facts['version']!r}")
        for field, fact in (("language", "language"), ("licence", "licence"),
                            ("base_ref", "base_ref"), ("contract", "contract")):
            if e.get(field) != facts[fact]:
                problems.append(f"{ref}: PROVENANCE_FACT_MISMATCH: {field} {e.get(field)!r} "
                                f"!= {facts[fact]!r} at {rev}")
        if e.get("wrapper_code_sha256") != facts["wrapper_code_sha256"]:
            problems.append(f"{ref}: PROVENANCE_WRAPPER_MISMATCH: wrapper_code_sha256 != "
                            f"sha256(method.json + {facts['run_file']}) at {rev}")
    if problems:
        for p in problems:
            print(f"provenance: {p}", file=sys.stderr)
        print(f"provenance: FAILED — {len(problems)} problem(s) in {len(envs)} entr"
              f"{'y' if len(envs) == 1 else 'ies'}", file=sys.stderr)
        return 1
    print(f"provenance: OK — {len(envs)} entr{'y' if len(envs) == 1 else 'ies'}' facts "
          f"hold at their recorded commits in {methods_dir}")
    return 0


def _lookup(obj: dict, path: str | None):
    if path is None:
        return None
    for top, default in (("envs", "env_id"), ("bases", "base_id")):
        if path.startswith(top + "["):
            i = int(path.split("[", 1)[1].split("]", 1)[0])
            field = path.split(".", 1)[1] if "." in path else None
            if field and " " in field:
                field = field.split(" ", 1)[0]
            items = obj.get(top) or []
            entry = items[i] if i < len(items) else {}
            return entry.get(field) if field else entry.get(default)
    return obj.get(path)


def write_manifest(records: list[dict], methods_dir: str, manifest_path: str,
                   record_dirs: dict, records_dir: str, *, previous_path: str | None = None,
                   replace_bases: tuple = (), drops: tuple = ()) -> None:
    """Assemble + write the manifest, then stage each NEW entry's and each
    newly emitted base's exact OCI artifact manifest bytes next to its record
    (ITEM-5 pushes those bytes, so the recorded digest is by construction
    the pushed digest). Carried entries were staged when they were built.
    The base records come from <records_dir>/bases. The previous list is read
    before the output is written, so `--previous X --manifest X` updates X."""
    previous = load_previous(previous_path) if previous_path else None
    base_records = load_staged_bases(records_dir)
    manifest, new, summary = assemble_manifest(records, methods_dir, base_records,
                                               previous=previous,
                                               replace_bases=replace_bases, drops=drops)
    parent = os.path.dirname(manifest_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(manifest_path, "wb") as f:
        f.write(manifest_bytes(manifest))
    for rec in records:
        key = (rec.get("env_id"), rec.get("arch"))
        layer_dir = record_dirs.get(key)
        if layer_dir is None:
            raise SystemExit(f"record {_ref_of_record(rec)}: unknown layer dir")
        with open(os.path.join(layer_dir, "oci-manifest.json"), "wb") as f:
            f.write(oci_artifact_manifest_bytes(rec, new[key]["contract"]))
    staged = {(b["base_id"], b["arch"]): b for b in base_records}
    for emitted in manifest["bases"]:
        b = staged.get((emitted["base_id"], emitted["arch"]))
        if b is None or emitted_base(b) != emitted:
            continue  # a carried base: staged when it was built
        base_dir = os.path.join(records_dir, "bases", f"{b['base_id']}-{b['arch']}")
        with open(os.path.join(base_dir, "oci-manifest.json"), "wb") as f:
            f.write(oci_base_manifest_bytes(b))
    n = len(manifest["envs"])
    print(f"manifest written: {manifest_path} ({n} env entr{'y' if n == 1 else 'ies'})")
    if previous is not None:
        for what in ("added", "replaced", "unchanged", "dropped"):
            if summary[what]:
                print(f"  {what:9s}: " + ", ".join(_key_ref(k) for k in summary[what]))
        print(f"  carried  : {len(summary['carried'])} entr"
              f"{'y' if len(summary['carried']) == 1 else 'ies'} from {previous_path}")
        if summary["bases"]:
            print("  bases    : from the build dir " + ", ".join(summary["bases"]))


# ─────────────────────────────── CLI ─────────────────────────────────────────
def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Build per-method environment layer artifacts and write/"
                    "check the committed env manifest (node "
                    "method-env-images, ITEM-2 + ITEM-3). No push.")
    parser.add_argument("--only", nargs="+", metavar="ID",
                        help="build only these method ids (default: every gated "
                             "method at the methods HEAD); with --assemble, take "
                             "only these ids' records")
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
                        help="assemble + write the manifest to PATH (after a build: "
                             "from this run's records; with --assemble: from the "
                             "records under DIR); with --check / --check-provenance: "
                             "the file to check, default "
                             "src-app/server/data/method-env-images.json")
    parser.add_argument("--previous", metavar="PATH",
                        help="carry the entries and bases of this schema 2 list; "
                             "the records replace or add their entries")
    parser.add_argument("--full", action="store_true",
                        help="every entry from a record, the bases from the staged "
                             "bases (a first list, or a full rebuild)")
    parser.add_argument("--replace-base", action="append", default=[], metavar="BASE-ARCH",
                        help="with --previous: take the staged base <base_id>-<arch> "
                             "(a base batch: every entry on a changed base image must "
                             "be rebuilt in the same assembly, or dropped)")
    parser.add_argument("--drop", action="append", default=[], metavar="ENV-ARCH",
                        help="with --previous: remove the entry <env_id>-<arch>")
    parser.add_argument("--check", action="store_true",
                        help="assemble only (no docker) and compare against "
                             "--manifest: --full (the default) = every entry "
                             "re-assembles from the staged records; --previous = "
                             "carried entries byte-identical to that list, the others "
                             "re-assembled; --entry/--base-entry = those entries only")
    parser.add_argument("--entry", action="append", default=[], metavar="ENV-ARCH",
                        help="with --check / --check-provenance: check this entry")
    parser.add_argument("--base-entry", action="append", default=[], metavar="BASE-ARCH",
                        help="with --check: check this base against its staged record")
    parser.add_argument("--check-provenance", action="store_true",
                        help="check every entry's facts (or --entry ones) against the "
                             "methods repository at the entry's own commit")
    parser.add_argument("--assemble", "--fixture", dest="assemble", metavar="DIR",
                        help="read staged records from DIR/layers and DIR/bases "
                             "without building (assemble-only; --fixture is the "
                             "old name)")
    parser.add_argument("--base-pins", metavar="PATH",
                        help="build on the bases this list pins, from the local "
                             "image store (default: the committed list)")
    parser.add_argument("--new-base", action="store_true",
                        help="a base batch: resolve the base as before (local, pull, "
                             "benchmark tree) and stage it, instead of the pinned one")
    parser.add_argument("--no-trim", action="store_true",
                        help="debugging only (DEC-12: trim constants are fixed)")
    parser.add_argument("--keep-rootfs", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force-base-build", action="store_true")
    parser.add_argument("--stage-bases", action="store_true",
                        help="build nothing: stage the base artifact of every "
                             "language the --arch layer records in --out use "
                             "(from the base cache or the local image with "
                             "the recorded digest)")
    args = parser.parse_args(argv)

    if args.assemble and args.out:
        parser.error("--assemble/--fixture and --out are exclusive; --assemble <dir> "
                     "reads records from <dir>/layers and never builds")
    if args.full and args.previous:
        parser.error("--full and --previous are exclusive")
    if (args.replace_base or args.drop) and not args.previous:
        parser.error("--replace-base and --drop need --previous (they change a "
                     "previous list)")
    if (args.entry or args.base_entry) and not (args.check or args.check_provenance):
        parser.error("--entry and --base-entry go with --check or --check-provenance")
    if args.check and args.check_provenance:
        parser.error("--check and --check-provenance are separate runs")
    if args.check and not args.assemble and not args.out:
        parser.error("--check needs the staged records: pass --out <dir> or "
                     "--assemble <dir>")
    if args.new_base and args.base_pins:
        parser.error("--new-base and --base-pins are exclusive")
    if args.force_base_build and not args.new_base:
        parser.error("--force-base-build rebuilds the base: only with --new-base (a "
                     "pinned build uses the local image at the pinned digest)")

    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    committed_path = os.path.join(repo_root, DEFAULT_MANIFEST_PATH)
    manifest_path = args.manifest or committed_path

    if args.check_provenance:
        return check_provenance(manifest_path, args.methods_dir, args.entry)

    if args.check:
        records_dir = args.assemble or args.out
        records = load_staged_records(records_dir)
        base_records = load_staged_bases(records_dir)
        rc = 0
        if args.entry or args.base_entry:
            rc = check_entries(records, args.methods_dir, manifest_path, base_records,
                               args.entry, args.base_entry)
        if rc == 0 and args.previous:
            rc = check_previous(records, args.methods_dir, manifest_path, base_records,
                                load_previous(args.previous))
        elif rc == 0 and (args.full or not (args.entry or args.base_entry)):
            rc = check_full(records, args.methods_dir, manifest_path, base_records)
        return rc

    if args.manifest and not (args.full or args.previous) and not args.dry_run:
        parser.error("ASSEMBLE_MODE: writing a manifest needs --previous <list> (carry "
                     "its entries; the records replace or add theirs) or --full (every "
                     "entry from a record) — a one-method list is never written by "
                     "accident (FOLLOW-UPS 77)")

    if args.assemble:
        records = load_staged_records(args.assemble)
        if args.only:
            records = [r for r in records if r.get("env_id") in set(args.only)]
        if not args.manifest:
            parser.error("--assemble requires --manifest <path> (write) or --check "
                         "(parity)")
        write_manifest(records, args.methods_dir, manifest_path,
                       _record_dirs_of(args.assemble, records), args.assemble,
                       previous_path=args.previous, replace_bases=tuple(args.replace_base),
                       drops=tuple(args.drop))
        return 0

    if args.stage_bases:
        if not args.out:
            parser.error("--stage-bases needs --out <dir> (the build dir that "
                         "holds the layer records)")
        if args.arch not in ("amd64", "arm64"):
            parser.error("--arch must be amd64 or arm64")
        try:
            return stage_bases_for_records(args.out, args.arch, args.dry_run)
        except (BuildError, DockerStageError, OSError) as e:
            print(f"\nFAIL stage-bases: {e}", file=sys.stderr)
            return 1

    if not args.out:
        parser.error("--out is required (TXR_ENV_BUILD_DIR also works); the "
                     "staging dir must live outside the repo")
    if not os.path.isdir(args.methods_dir):
        parser.error(f"methods directory {args.methods_dir} is not a "
                     "directory (TXR_METHODS_DIR / --methods-dir)")
    # verify_arch before any build (mirror the publisher's own check).
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
    if not args.new_base:
        args.base_pins = args.base_pins or committed_path
        args.pins = load_base_pins(args.base_pins)

    git = methods_git(args.methods_dir)
    head = git.commit("HEAD")
    if head is None:
        print(f"FAIL: the methods dir {args.methods_dir} has no HEAD commit", file=sys.stderr)
        return 1
    selected = list(args.only) if args.only else gated_method_ids(git, head)
    if not selected:
        print(f"FAIL: no gated method at HEAD {head[:12]} of {args.methods_dir} — "
              "nothing to build", file=sys.stderr)
        return 1
    print(f"methods dir : {args.methods_dir} (HEAD {head[:12]})")
    print(f"out         : {args.out}")
    print(f"arch        : {args.arch}   ({len(selected)} method(s))")
    print(f"base        : {'a new base batch (--new-base)' if args.new_base else 'pinned by ' + args.base_pins}")
    records = []
    for eid in selected:
        try:
            records.append(build_one(eid, args))
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
            print("+ stage <layer_dir>/oci-manifest.json per new entry")
        else:
            write_manifest(records, args.methods_dir, manifest_path,
                           _record_dirs_of(args.out, records), args.out,
                           previous_path=args.previous,
                           replace_bases=tuple(args.replace_base), drops=tuple(args.drop))
    return 0


def _record_dirs_of(records_dir: str, records: list[dict]) -> dict:
    """(env_id, arch) -> the layer dir that holds artifact.json, for the
    writer's oci-manifest.json staging."""
    return {(r["env_id"], r["arch"]): os.path.join(
        records_dir, "layers", f"{r['env_id']}-{r['arch']}") for r in records}


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
