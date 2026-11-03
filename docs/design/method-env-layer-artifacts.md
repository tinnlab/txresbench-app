# Per-method environment layer artifacts — the stacked-layer design

> Binding reference for the `method-env-images` node (epic `txresbench-app`).
> Where this document and a generated artifact disagree, the artifact is wrong
> (INV-5: the manifest is generated, never hand-edited). Where this document and
> the runtime disagree on MOUNT semantics, the equivalence test (§9) is the
> arbiter: a stacked run must produce byte-identical predictions to the full
> method image, or the stack is wrong regardless of which side reads better.

## §1 What is being designed

The desktop app runs each benchmark method inside the ziee sandbox. The
shipped sandbox mounts ONE per-domain env rootfs; the app's design replaces
that with a **stack**: a trimmed **per-language base rootfs** (R or Python,
built and published by the `sandbox-stacked` node) plus one small
**per-method layer** below. The clinician downloads the base once per language
and one small layer per method — the board's per-method download rows
("downloading 160 of 250 MB", a design example) instead of a full environment
per method.

This document defines the **artifacts** only: what a layer is, what the
manifest records, how a layer is built (build-time only, on the publisher's
machine), and what the runtime must be able to conclude from them. It does not
define the runtime's fetch/verify/mount machinery (`sandbox-stacked`), the
download-state machine (`execution-engine`), or the method catalogue
(`method-catalogue`); it defines the contracts those nodes consume.

Every layer is derived from the **benchmark method Dockerfile** at a recorded
revision: the wrapper code and pinned dependencies are the method's own bytes.
Nothing here reads the benchmark tree at run time, and nothing here fetches
anything outside the allowed uses (download the layers, check for updates).

## §2 The artifact set

Four deliverables at ITEM-1, all committed; the pipeline scripts are later
items:

| artifact | path | produced by |
|---|---|---|
| design (this file) | `docs/design/method-env-layer-artifacts.md` | this node |
| manifest | `src-app/server/data/method-env-images.json` | `scripts/generate-method-env-images.py` (ITEM-2/3) |
| manifest JSON Schema | `src-app/server/data/method-env-images.schema.json` | this node (hand-written, versioned) |
| data README | `src-app/server/data/README.md` | this node |
| OCI artifact | `ghcr.io/tinnlab/txr-method-env-layers/<env_id>:<method_version>-<arch>` | `scripts/publish-method-env-images.sh`, owner-gated |
| build/publish/verify scripts | `scripts/generate-method-env-images.py`, `scripts/publish-method-env-images.sh`, `scripts/lib/method-env-verify.sh` | ITEM-2/5/7 |
| regen-parity guard | `scripts/check-method-env-images.sh` (+ `.test.mjs`) | ITEM-4 |

The manifest is the authoritative record per environment: the runtime fetches
`oci_ref@digest`, verifies `layer_sha256` before mounting, and the UI shows
`size_bytes` before starting the download (manifest-first, digest-pinned —
DEC-7). A saved model records the entry's `digest` and `base_digest` verbatim,
so an exact re-fetch and an exact provenance claim are always possible
(INV-6). `env_id == method_id` (DEC-1), valid per
`src-app/server/src/modules/sandbox/env_id.rs::is_valid_env_id` (lowercase
alnum + `.` `_` `-`); the method catalogue emits the same string as its env id.

### §2.1 The manifest entry, field by field

Top level: `schema_version` (1), `generator_version`, `source_revision`
(methods-repo commit, 12 hex), `base_contract` (the container-contract version
the benchmark base images are built under; `"2.0"`), `envs` (sorted by
`env_id`). No wall-clock field (DEC-15).

Per entry:

| field | definition | example |
|---|---|---|
| `env_id` | `== method_id` (DEC-1) | `landmark-cox-current` |
| `method_id` | the methods-repo method folder id | `landmark-cox-current` |
| `method_version` | `index.json` `version` | `2.0.0` |
| `language` | `R` \| `Python` (index.json `language`) | `R` |
| `arch` | `amd64` \| `arm64` (D09: amd64 only for now) | `amd64` |
| `oci_ref` | the artifact repo, no tag/digest | `ghcr.io/tinnlab/txr-method-env-layers/landmark-cox-current` |
| `tag` | `<method_version>-<arch>`, immutable by publisher discipline | `2.0.0-amd64` |
| `digest` | OCI content digest (`sha256:`) of the artifact manifest | `sha256:9f1c…` |
| `layer_sha256` | sha256 of the published `layer.squashfs` bytes | 64 hex |
| `size_bytes` | `layer.squashfs` byte length | `123456789` |
| `base_ref` | the benchmark base the delta was computed against | `ghcr.io/tinnlab/txresbench-base-r:2.0` |
| `base_digest` | that base image's digest | `sha256:4a2b…` |
| `contract` | `index.json` `contract` (equals `base_contract` today) | `2.0` |
| `licence` | `method.json` `licence`, verbatim (TEST-11) | … |
| `wrapper_code_sha256` | one hash of the wrapper payload (§2.2) | 64 hex |
| `layer_schema` | `1` (§5) | `1` |

`base_ref`, `base_digest`, `contract` and `licence` are provenance facts, not
runtime fetch targets: the runtime's base ref is `sandbox-stacked`'s artifact
(`ghcr.io/tinnlab/txresbench-env/…`), paired by digest (see §7).

### §2.2 `wrapper_code_sha256` — the byte convention

The plan names the field but not its bytes; the exact convention is pinned
here so the manifest writer and the verifier cannot drift. It is the lowercase
hex sha256 of the byte concatenation

```
<bytes of /code/method.json> || <bytes of the wrapper file (/code/run.R or /code/run.py)>
```

in that order — the method's own payload, nothing the build added, no path
names, no separators. TEST-1/EX-1 verify this field against the layer's
actual `/code` files.

## §3 Delta semantics

Per method (DEC-3, INV-1):

1. `docker build --platform <arch>` the method's Dockerfile exactly as
   published. The build is **refused** if the Dockerfile does not start with
   `FROM` a per-language base image — the classifier checks the first `FROM`
   line against `ghcr.io/tinnlab/txresbench-base-(r|py):<contract>`. The base
   image the build resolved is recorded as `base_ref`/`base_digest`.
2. `docker create` + `docker export` **both** the method image and its base
   image; extract both rootfs tar streams to directories.
3. The **delta** = every path present in the method rootfs whose path is
   absent from the base rootfs, or whose content differs (regular files by
   bytes; symlinks by target; directories by existence). Paths present only in
   the base rootfs are **deletions**: refused unless under the excluded tops.
4. Paths under the excluded tops are never part of the delta (a new file under
   `/tmp` or under `/var/cache` is build debris; TEST-4 asserts a `/tmp`-only
   artifact never appears in the delta). For the same reason a deletion under
   an excluded top is not an error (methods routinely clean apt caches).
5. The delta is trimmed (§4), the schema marker and
   `/layer-manifest.json` are emitted (§5), modes are normalized (§5), and the
   result is packed with the shipped `single-cell` recipe's own packer flags
   (`mksquashfs -comp zstd -Xcompression-level 22 -b 1M -noappend -no-progress
   -all-root` — the recipe's full line; the abbreviated form in the PLAN is a
   summary, not a different recipe).

### §3.1 The deletion rule, with the cover known

The literal per-path reading of step 3's deletion refusal is refined once the
**cover** (§5.1) is known, and the two must be read together:

- a deletion **under a cover entry's subtree** is the method's *replacement*
  of that subtree — the entry carries the method image's full subtree at that
  path (§5.1), and a bind of the entry shadows the base's version wholesale
  (§8), so the removal is exactly what the method image does. The canonical
  case is a changed package: the method re-installed `pkg` at a new version
  that dropped a file the base's version had, and the layer must NOT restore
  it. Allowed.
- a deletion **outside every cover entry's subtree**: if the method image
  genuinely lacks a base path the layer does not overlay, the stacked run
  would show the base's file where the method image has none — a silent
  divergence the refuse rule exists to prevent. Refused, naming the topmost
  paths.
- a deletion under an excluded top: allowed (methods clean their own caches).

The generator therefore computes the cover first (from added/changed) and only
then decides which deletions refuse; the deletion check is never a separate
pre-pass that would refuse a legitimate package replacement.

The excluded tops (the exact list, in both directions — deleted from base:
allowed, added/changed under them: dropped from the delta):

```
/tmp  /var/cache  /var/lib/apt/lists  /root  /run  /proc  /sys  /dev
```

Any other deletion **fails the build and lists the paths** — a layer never
silently removes a file the benchmark base provides, because the base the
runtime uses is a *trim* of that same benchmark base and the trim's deletions
are its own deliberate, reviewed set (the pairing check, §7, verifies the
two agree on identity, not on contents).

### §3.1 Mode normalization and the 0600 refusal

The 0600-wrapper failure (`/code/run.py` unreadable to the container's
non-root user) is a repeated benchmark record; the generator normalizes every
delta file to `>= 0644` and every directory to `>= 0755` after the delta is
computed, and a 0600 wrapper is a **hard error** (naming the file), not a
silent chmod — TEST-3/EX-7 assert the layer never contains a 0600 wrapper.

## §4 Trim rules

Conservative trim, the shipped `single-cell` recipe's own set (DEC-12), as
fixed constants in the generator (DEC-13); `--no-trim` exists for debugging
only:

- `strip --strip-unneeded` on every `*.so` / `*.so.*` (the big win; failures
  of strip are ignored the way the shipped recipe ignores them);
- delete `include/` directories, `*.a`, `tests/`, `test/`, `docs/`, `doc/`,
  `examples/` directories, `__pycache__/`, `*.pyc`;
- KEEP `.pyi`/`.pyx`/`.pxd` (skimage/scipy lazy loaders read them), KEEP R
  package metadata (`Meta/`, `R/`) and man pages untouched.

Trimming is what makes the delta small; it is also what makes the *equivalence
test* (§9) the mandatory proof — "an install the smoke line does not verify
silently ships absent" carried to the layer level.

## §5 Layer filesystem contract (PROV-method-env-images-3)

The published `layer.squashfs` (zstd, `mksquashfs -comp zstd -b 1M -all-root`)
contains:

- `/code/method.json` and `/code/run.py` or `/code/run.R` — the method's own
  wrapper bytes (the two files `wrapper_code_sha256` hashes);
- the method's installed package files at the same paths the per-language base
  uses (the delta — the added/changed files, not a copy of the base);
- `/.txr-method-env-layer-schema`, content `1` (LAYER_SCHEMA_VERSION, DEC-11:
  the same marker discipline as the shipped `/.cytoanalyst-sandbox-rootfs-schema`),
  mirrored in the manifest entry (`layer_schema` = integer `1`) and in the
  artifact annotation (`com.txr.layer_schema` = `"1"`); the runtime compares
  the marker to the manifest value and refuses a mismatch;
- `/layer-manifest.json` — a JSON array of the layer's mount entries
  (reconcile-grown; bound by `sandbox-stacked` PROV-SS-2): each entry an
  absolute, `..`-free path under `/usr/local`, `/opt` or `/code`; `/code` must
  be present. The build refuses a manifest that names a path outside the
  allowed prefixes or omits `/code`.

The entries are the **subtree-closed cover** of the delta — the rule that
makes a per-entry bind (the shipped mount loop) equivalent to a union. An
entry may be any delta path, subject to entry closure (§5.1); the generator
derives the minimal such cover at the finest granularity and emits it sorted.
They are exactly what the runtime's mount loop consumes. The plan's
illustrative shape `["/usr/local/lib/R/site-library", "/opt", "/code"]` is a
coarse entry; a real generator emits the closed cover (new package dirs,
changed package dirs, `/code`), never `site-library` as a whole subtree — see
§5.1/§8.

### §5.1 The content rule — what the layer actually carries

The delta is per-file (DEC-3), but the layer is only correct if a bind of any
entry's subtree reproduces the method image's subtree at that path. The
content rule:

> For every entry `P`, the layer carries every file the method image has
> under `P` (not only the added/changed ones).

For an entry whose path does not exist in the base rootfs, "every file the
method image has" is the delta itself. For an entry whose path the base also
provides (a shared directory — the per-language bases install into
`/usr/local/lib/python3.11/site-packages` and
`/usr/local/lib/R/site-library`), the layer carries the method image's **full
subtree** at that entry, which for the unmodified shared packages is nothing
(the base already has identical bytes) and for a changed package is the
method's version of that package (the file that changed plus the unchanged
files of the same package — a bind cannot see "the rest of the package" if it
shadows the path).

The generator therefore closes each entry downward to the finest granularity
that keeps the delta small:

- a **new** package directory (absent from the base) is its own entry and
  stays at delta size (e.g. `pip`'s new `site-packages/<pkg>` dirs, `R CMD
  INSTALL`'s new `site-library/<pkg>` dirs);
- a **changed** package directory (present in the base, at least one file
  differs) is its own entry and carries the method's full package subtree
  (e.g. `survival` re-installed at a different version);
- `/code` is always an entry and carries the method's wrapper bytes;
- nothing else is ever an entry — a path shared with the base whose delta is
  empty is not an entry at all, and `site-library`/`site-packages` are never
  whole-subtree entries unless the method image's whole subtree changed
  (which the delta defines).

### §5.2 System-library deltas — measured constraint

The allowed prefixes are `/usr/local`, `/opt`, `/code` (reconcile-bound with
`sandbox-stacked`'s validated set). A method Dockerfile that installs system
packages puts them under `/usr` (bin/lib/share), which is outside every
allowed prefix, so such a method's layer **cannot be built under this
contract** — the build refuses and names the paths (PROV-3's refusal rule,
enforced by the generator).
Measured on the methods repository at `5db3b60f727d`: 17 of 391 method
Dockerfiles use `apt-get`; of the 95 runnable methods exactly
**`jmbayes-value-cumulative`** does (`apt-get install jags` →
`/usr/bin/jags`, `/usr/lib/jags`, `/usr/share/jags`). This is one method, and
it is a hard refusal under the frozen contract, not a silent skip: the
generator reports it as an error naming the id and the paths. Candidate
repairs (a later item's, owner-gated): (a) grow the allowed prefix set to
include `/usr` with the overlay-union mount (§8) — the shipped runtime's
prefix list is compiled and parity-locked, so the growth is a deliberate
`sandbox-stacked` change; (b) fold the shared system dependency into the
per-language trimmed base (jags is method-specific, so this is the wrong
shape here); (c) treat the method as layer-less. (a) is the design-consistent
route; ITEM-6's full run measures the actual delta before any is chosen.

## §6 The OCI artifact (PROV-method-env-images-2)

`ghcr.io/tinnlab/txr-method-env-layers/<env_id>` (DEC-2; distinct repo prefix
so the layer artifacts are never read as benchmark method images), artifact
type `application/vnd.txr.method-env.layer.v1`, exactly one file
`layer.squashfs`, immutable tag `<method_version>-<arch>`, cosign-signed
(provenance floor; the manifest's sha256 is the verification floor, DEC-5).
Annotations, exactly:

| annotation | value |
|---|---|
| `org.opencontainers.image.source` | `https://github.com/tinnlab/txresbench-methods` |
| `org.opencontainers.image.revision` | methods-repo commit |
| `com.txr.method_id` | method id |
| `com.txr.method_version` | `method_version` |
| `com.txr.language` | `R` \| `Python` |
| `com.txr.arch` | `amd64` \| `arm64` |
| `com.txr.contract` | contract version |
| `com.txr.base_ref` | `base_ref` |
| `com.txr.base_digest` | `base_digest` |
| `com.txr.layer_sha256` | `layer_sha256` |
| `com.txr.layer_schema` | `"1"` |

The publisher mirrors `scripts/publish-env-rootfs.sh` (login → push with
artifact type + annotations → immutable tag → cosign sign; `--dry-run`,
`--env`, `--arch`, `--skip-sign`; refuses cross-arch builds and refuses
overwriting a tag whose remote digest differs).

### §6.1 The artifact manifest bytes — pinned construction (ITEM-3)

The manifest entry's `digest` is the OCI content digest of the artifact
manifest the registry stores, and ITEM-6 commits it **before any push** —
so the writer constructs the exact bytes itself (ITEM-2 implementation
note h: "resolvable locally with an oras-style manifest construction").
The construction is pinned here, in one place, because the value is
meaningless unless it is reproducible:

```
{
  "schemaVersion": 2,
  "mediaType": "application/vnd.oci.image.manifest.v1+json",
  "artifactType": "application/vnd.txr.method-env.layer.v1",
  "config": {
    "mediaType": "application/vnd.oci.empty.v1+json",
    "digest": "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    "size": 2
  },
  "layers": [
    {
      "mediaType": "application/vnd.txr.method-env.layer.v1",
      "digest": "sha256:<layer_sha256>",
      "size": <size_bytes>,
      "annotations": { "org.opencontainers.image.title": "layer.squashfs" }
    }
  ],
  "annotations": { <the §6 table verbatim, in table order> }
}
```

Key order is the OCI struct order (Go's `json.Marshal` field order), no
whitespace, ASCII-only values (no HTML escapes), `com.txr.layer_schema` as
the string `"1"` (annotations are strings, DEC-11). The layer's
`mediaType` is the artifact type itself — the publisher's `oras push`
spells the file `layer.squashfs:<ARTIFACT_TYPE>`, exactly the
`publish-env-rootfs.sh` shape — and the layer descriptor carries the file
title annotation (oras's file-push convention).

The writer stages these exact bytes as
`<staging>/layers/<env_id>-<arch>/oci-manifest.json` when it writes the
manifest, so ITEM-5's publisher pushes **those bytes** (and verifies):
`oras resolve` after the push must equal the recorded `digest`, and any
difference refuses the publish naming both digests — a byte-exactness
mismatch with a specific oras version is then a one-line correction to
this construction followed by a regeneration, never a silent divergence
between the manifest and the artifact. ITEM-7's loopback test is the
runtime-side witness of the same equality (pull by digest → hash/size
match).

## §7 Base pairing — no silent substitution (INV-3, DEC-4)

The layer is a delta over a **specific** benchmark base. The manifest records
that identity (`base_ref`, `base_digest`). The app-side trimmed per-language
base (`sandbox-stacked`'s artifact) **must** be a trim of that exact benchmark
base and must carry the OCI annotation

```
com.txr.trimmed-from-digest = <base_digest>
```

The runtime refuses a stack where the two disagree — a typed error naming
both digests. `base_ref` is not a runtime fetch target (the runtime's base
ref is `sandbox-stacked`'s `ghcr.io/tinnlab/txresbench-env/…` namespace): the
pairing is the digest anchor, never the name. This is the invariant that makes
"a mismatch never mounts silently" a checkable property.

## §8 Mount semantics — the layer is a union

The delta-per-file model is only correct if the layer **merges with** the
base. Two mounters are equivalent under §5.1, and no other shape is:

1. **Union (overlay)**: mount the layer's squashfs as the upper filesystem
   over the trimmed base as the lower (squashfuse + overlayfs — the plan's
   TEST-7 wording). The entries list is then documentation plus a sanity check
   (the overlay content must equal the closed cover it describes).
2. **Per-entry bind** (the shipped `bwrap --ro-bind-try` loop, PROV-SS-2):
   correct **iff** the entries are the §5.1 closed cover. A bind of any other
   subtree silently shadows: binding the layer's
   `/usr/local/lib/R/site-library` over the base's makes the base's R packages
   (`survival`, `nlme`, `jsonlite`, `SigBench` — present in base-r at exactly
   that path) vanish from the stack, which is the "stacked" failure mode, and
   it presents as a missing-R-package error at the clinician's machine.

The shipped runtime also asserts the parent of every entry exists in the base
rootfs (`assert_entry_parents_exist`); the closed cover satisfies that by
construction. The equivalence test (TEST-7,
`src-app/server/tests/sandbox/method_env_layer_test.rs`) is the arbiter: it
carries **both** a shared-subtree case (a changed package in the base's
library path, where shadowing is the classic failure) and a disjoint case, and
the stacked run must produce byte-identical predictions to the full image.

## §9 The equivalence test (EX-7 / TEST-7)

Given a fixture method (tiny Python or R method defined in the test), a
fixture base, the pipeline's built layer, and a loopback `registry:2`
(EnvImageSeams-style explicit configuration, no process-env mutation):

1. the artifact is pulled by digest; `layer_sha256` and `size_bytes` match the
   manifest;
2. the schema marker reads `1` and matches the manifest's `layer_schema`; all
   wrapper files are `>= 0644`;
3. the stacked layer (squashfuse + overlay union over the base) runs the
   contract fit/predict, and the **full fixture image** runs the same contract;
   `predictions.csv` is byte-identical, and the layer contains no 0600 wrapper.

This is the only test that closes the trim/shadow/prefix loop: a layer that
deletes a needed file, shadows a base subtree, or was over-trimmed fails here,
not at a clinician's machine. Tool-gated (docker, oras, cosign, squashfuse,
bwrap) through the shared skip recorder.

## §10 Determinism, regeneration, parity (INV-5)

One source revision → one manifest. `source_revision` is the methods-repo
commit (12 hex), entries sorted by `env_id` (then `arch` within an id), no
wall-clock field, no temp paths. The writer (the same
`scripts/generate-method-env-images.py`, ITEM-3) assembles entries from
the staged `artifact.json` records plus the index facts (`contract`) and
`method.json` (`licence`, verbatim — TEST-11) and refuses (naming the
record) any record whose env_id ≠ method_id, tag ≠ `<version>-<arch>`,
oci_ref/base_ref prefix, digest/sha256 shape, arch or language is off, or
whose index entry is missing or not `runnable` (DEC-8). Modes:

- `--manifest <path>` after a build run writes the manifest (and stages
  each entry's `oci-manifest.json`); `--fixture <dir> --manifest <path>`
  writes from a fixture staging dir without building (the tests' mode).
- `--check` assembles only and byte-compares against `--manifest`
  (default `src-app/server/data/method-env-images.json`); a difference
  exits 1 naming the first differing key (`envs[3].licence`,
  `source_revision`, …) — TEST-2's failure shape. A hand-edit is a guard
  failure naming the first differing key.
- `--source-revision <12hex>` pins the expected revision: every staged
  record must carry it (an explicit audit pin; the parity comparison
  against the committed file's own revision is the default check).

Byte-determinism caution: the writer's byte parity is about the
manifest, not the squashfs. `--check` needs the staging dir the layers
were built into (records + hashes are build outputs), so the ITEM-4
guard's real-mode parity leg is a publisher-machine check against the
recorded revision — on clean CI-style boxes only the fixture parity
exercises it (see the ITEM-1 note on TEST-2). The guard itself
(`scripts/check-method-env-images.sh`, pinned by
`check-guard-integrity.sh`, wired into `just check-guards`) additionally
re-validates the committed file structurally — schema, id grammar,
`sha256:` formats, `size > 0`, arch set, `base_ref` prefix, `oci_ref`
prefix, uniqueness, sorted order, no status/placeholder text.

## §11 Invariants → mechanisms

| invariant | mechanism |
|---|---|
| INV-1 (method's own bytes) | build the published Dockerfile; refuse non-per-language `FROM`; source revision recorded |
| INV-2 (public OCI, no status text) | `ghcr.io` only (`scripts/network-allowlist.txt`, unchanged); manifest carries data fields only; the guard refuses status/placeholder vocabulary |
| INV-3 (paired base) | `base_ref`/`base_digest` + `com.txr.trimmed-from-digest`; typed refusal naming both digests |
| INV-4 (immutable + offline-verifiable) | digest + `layer_sha256` + `size_bytes` in the manifest; fetch by digest; verify offline before mount |
| INV-5 (generated, deterministic, guarded) | no wall clock; sorted; `--check` byte-parity; regen-parity guard pinned in `guard-hashes.txt` |
| INV-6 (provenance-by-reference) | entry carries method id/version + base + layer digests, consumed verbatim by run records and saved models |

## §12 Non-goals

- The trimmed per-language base image and its recipe: `sandbox-stacked`
  (this node records the base the layer was computed against and the pairing
  anchor the base must carry).
- The fetch/verify/mount machinery, download-state machine and progress:
  `sandbox-stacked` / `execution-engine`.
- The method catalogue and its env id emission: `method-catalogue`
  (this node pins the convention).
- Any UI. Any push: the publish step is owner-gated; the pipeline is fully
  runnable with `--dry-run` and the manifest is committed from a local build.
- A per-layer size budget in v1: DEC-16 reports measured sizes instead.
