# Runbook — publishing the per-method environment layers

Owner: whoever is publishing a method environment layer to
`ghcr.io/tinnlab/txr-method-env-layers` (one package for every layer) or a
base to `ghcr.io/tinnlab/txresbench-env` (one package for both bases) after a
build or a methods-revision bump. The publish step is **owner-gated by decision** (D10 in
`.lifecycle/txresbench-app/OWNER-DECISIONS.md`: "Owner publishes, workers
rehearse"): no worker, no CI, no GitHub Action publishes a layer — this
document and `scripts/publish-method-env-images.sh` are the path.

---

## 0. Read this first: what is and is not automated

Nothing about the layers is published automatically. The app-epic build runs
entirely on the build machine; the framework's Actions workflows are parked
(billing) and the app repo adds none. The consequence is the same as for the
framework's env image, documented in
(see the layer-delta rule): a layer that exists only in a
staging directory is a layer no clinician can download.

What each step owns, and who may run it:

| step | tool | who |
|---|---|---|
| build a layer (and stage its base) | `scripts/generate-method-env-images.py` | worker or owner (the pipeline) |
| stage the bases of already-built layers | `scripts/generate-method-env-images.py --stage-bases` | worker or owner |
| assemble + commit the manifest | the same generator (`--manifest`) | worker (ITEM-6 commits it) |
| validate the committed manifest | `scripts/check-method-env-images.sh` | the gate (every commit) |
| publish a base, then layers | `scripts/publish-method-env-images.sh --base` / `--env` | **owner only** |
| rehearse a publish on a local registry | `scripts/publish-method-env-images.sh --registry 127.0.0.1:<port>` | worker or owner |
| behavioral verify of a layer | `scripts/lib/method-env-verify.sh` | the publish path (ITEM-7) |

The layer artifacts follow a **digest-pinned** contract (DEC-7, owner
decision D04): the committed manifest entry carries the OCI artifact digest,
the layer sha256 and the size; the runtime fetches `oci_ref@digest`, verifies
the sha256 offline and only then mounts. There is **no moving tag** — unlike
the framework's env image, a new layer becomes visible to a clinician only
via a new app build that embeds the regenerated manifest (see §6).

---

## 1. What lives where

| thing | path | what it decides |
|---|---|---|
| the methods repository (read-only build input) | `/data/share/pbya/sigtrans/methods` (overridable: `TXR_METHODS_DIR`) | which methods exist, their versions, licences, contract, `runnable` flag |
| the layer builder | `scripts/generate-method-env-images.py` | builds each method's own Dockerfile, computes the delta over its per-language base, emits the squashfs layer |
| the staged layer | `<build-dir>/layers/<env_id>-<arch>/{layer.squashfs, artifact.json, oci-manifest.json}` | the artifact and the record the manifest writer consumes |
| the staged base | `<build-dir>/bases/<base_id>-<arch>/{base.squashfs, artifact.json, oci-manifest.json}` (rootfs cache: `<build-dir>/base-cache/`) | the per-language base every layer of that language and arch stacks on (design §6.3) |
| the env manifest (the contract) | `src-app/server/data/method-env-images.json` (+ `.schema.json`) | the runtime's fetch/verify source; generated, never hand-edited (INV-5) |
| the manifest guard | `scripts/check-method-env-images.sh` | schema + structural validation + regen parity (whole list, or entry by entry against the previous list) + per-entry provenance against the methods repository |
| the publisher | `scripts/publish-method-env-images.sh` | verify the staged bytes → login → push → verify the digest → sign |
| the behavioral verifier | `scripts/lib/method-env-verify.sh` (ITEM-7) | extracts the staged layer and verifies its artifact contract (marker, wrapper, modes, entries, `usr/` sentinel); EX-7's stacked equivalence is the Rust test's arbiter |
| the artifact contract (the design) | `docs/method-env-layer-artifacts.md` | delta semantics, trim rules, layer filesystem contract, the pinned OCI manifest bytes (§6/§6.1) |

---

## 2. The pipeline in one page

```
methods repo (revision R)
   │  generate-method-env-images.py --only <id> --manifest <path>
   ▼
<build-dir>/layers/<env>-<arch>/         (squashfs + artifact record + oci-manifest.json)
   │                                   ← digest pinned in the manifest assembly
   ▼
src-app/server/data/method-env-images.json          (generated, commit-time)
   │  check-method-env-images.sh                     (gate: schema + parity)
   ▼
publish-method-env-images.sh --env <id>              (owner-gated: THIS runbook)
   │  verify bytes → login → blob push → manifest push → resolve == digest → sign
   ▼
ghcr.io/tinnlab/txr-method-env-layers:<id>-<version>-<arch>-<sha12>
```

Every layer is a tag of ONE package, `ghcr.io/tinnlab/txr-method-env-layers`,
the method and its layer file in the tag
(`<env_id>-<method_version>-<arch>-<first 12 hex of layer_sha256>`); both
bases are tags of ONE package, `ghcr.io/tinnlab/txresbench-env`
(`<base_id>-<contract>-<arch>-<sha12>`). GHCR sets visibility per package, by
hand, and a new tag in a public package is public at once — so a new method
needs no new package and no visibility change. Because the tag ends with the
file's hash, a rebuild at the same version that changes the file gets its
own tag; a rebuild that does not (layers pack reproducibly since generator
0.6.0, and the OCI manifest carries no commit or base) is the same artifact,
and publishing the same bytes again is a no-op.

Publish order matters: **bases first, layers second.** The layer is a
delta over the benchmark base image and records `base_ref`/`base_digest` as
provenance (DEC-4); a one-method build needs that base image on the machine
at the digest the list pins (§4; a base batch, `--new-base`, may pull it or
build it from `dev/code/benchmark/docker-images/base-{r,py}/`), and packs the app-side
base from it into `<build-dir>/bases/` (design §6.3). The manifest's `bases`
list pins each base file (`squashfs_sha256`) and pairs it with the layers by
`source_digest` == `base_digest`. The publisher refuses a layer until its base
tag resolves to the base record's digest, and refuses a manifest without a
`bases` list (one from before the base publisher: its layers could never run).

---

## 3. Publishing a base, then one layer

Prerequisites: `docker` (for any build), `oras` ≥ 1.2 (needs the `blob push`
and `manifest push` subcommands), `cosign` ≥ 2.4 (unless `--skip-sign`), and
a GHCR token with `write:packages` for the
`tinnlab/txr-method-env-layers` and `tinnlab/txresbench-env` packages.

```sh
export GHCR_USER=<your github username>
export GHCR_TOKEN=<a token with write:packages>
export TXR_ENV_BUILD_DIR=<the build staging dir>

# 1. build + stage the layer (ITEM-2/3; --only for one method, ITEM-6 for all)
python3 scripts/generate-method-env-images.py \
  --only <id> --out "$TXR_ENV_BUILD_DIR" --manifest <a-file-outside-the-repo-json>
# 2. validate the manifest it assembled (the gate; also run by the publisher)
scripts/check-method-env-images.sh --manifest <manifest> \
  --staging-dir "$TXR_ENV_BUILD_DIR"

# 3. always rehearse first — it prints every command and verifies every byte
scripts/publish-method-env-images.sh --base base-py --dry-run \
  --manifest <manifest> --staging-dir "$TXR_ENV_BUILD_DIR"
scripts/publish-method-env-images.sh --env <id> --dry-run \
  --manifest <manifest> --staging-dir "$TXR_ENV_BUILD_DIR"

# 4. publish the base the layer stacks on (once per language and arch), then the layer
scripts/publish-method-env-images.sh --base base-py \
  --manifest <manifest> --staging-dir "$TXR_ENV_BUILD_DIR" --methods-dir <methods checkout>
scripts/publish-method-env-images.sh --env <id> \
  --manifest <manifest> --staging-dir "$TXR_ENV_BUILD_DIR" --methods-dir <methods checkout>
```

Layers built before this staging step (no `<build-dir>/bases/`) get their bases
with `generate-method-env-images.py --stage-bases --out <build-dir> --arch
<arch>` on the machine that built them (it needs the base image with the
recorded digest, or the generator's base cache), then a fresh `--manifest --full`.

A build dir staged by a generator before 0.5.0 assembles as it is: its
records (record_schema_version 1) have no folder tree, so the writer takes it
from git at each record's commit, and the wrapper hash ties the record to
that commit. One staged before 0.4.0 (its records also carry the old
one-package-per-method address, `…/txr-method-env-layers/<env_id>` +
`<method_version>-<arch>`, and the bases `…/txresbench-env/<base_id>` +
`<contract>-<arch>-<sha12>`) needs no rebuild: assemble the manifest from it
with the current generator, assemble-only (no docker), then publish as above —

```sh
python3 scripts/generate-method-env-images.py --assemble "$TXR_ENV_BUILD_DIR" \
  --methods-dir <the methods checkout> --manifest <manifest> --full
```

The manifest gets the one-package addresses, derived from each record's
env_id/method_version/arch/layer_sha256 (a base: base_id/contract/arch/sha256),
and the same digests (the OCI manifest bytes carry no address). A record with
any other address is refused.

One invocation publishes exactly one artifact: `--env <id>` (one (env, arch)
layer) or `--base <base-py|base-r>` (one (base, arch) base). One of them is
required — nothing defaults across ~95 methods, and publishing the wrong
artifact under an immutable tag is not a recoverable mistake.

### What the publisher verifies before anything reaches the registry

1. The manifest entry (or `bases` record) exists, its `oci_ref` is the one
   package and its `tag` is its own
   (`<env_id>-<method_version>-<arch>-<first 12 hex of layer_sha256>`; a
   base: `<base_id>-<contract>-<arch>-<sha12>`), and the staged artifact's
   bytes are its bytes: `sha256(layer.squashfs) == layer_sha256` (a base:
   `sha256(base.squashfs) == squashfs_sha256`), the size matches,
   `sha256(oci-manifest.json) == digest` (the pinned construction, design
   §6.1/§6.3), and the build record agrees field-for-field. The record's own
   `oci_ref`/`tag` may instead be the one-package-per-method (or per-base)
   form of the same address that a generator before 0.4.0 wrote: a build dir
   staged before 0.4.0 assembles, with the current generator, into a
   one-package manifest with the same digests, and is published from as is.
2. The manifest satisfies the repo's own guard **including the regen-parity
   leg against the same staging dir** — a manifest whose records no longer
   reassemble is not published from.
3. The behavioral verifier (`scripts/lib/method-env-verify.sh`) runs: it
   extracts the staged `layer.squashfs` and verifies the artifact's own
   contract — schema marker, `/code` payload (method.json + exactly one run
   file), the wrapper hash (design §2.2), modes (never a 0600 wrapper), the
   layer-manifest rules + record equality, and the `usr/` mount-readiness
   sentinel — a failure refuses the publish. The stacked-equivalence claim
   (layer + base == the full method image, EX-7) is the
   `tests/sandbox/method_env_layer_test.rs` arbiter, not part of the publish
   gate. A base instead must list `/opt/txr-layer` (and
   `/opt/txr-layer/R-library` for base-r), `/usr/bin/prlimit` and
   `/usr/bin/bash` (`unsquashfs -lln`).
4. The version tag does not already hold **different bytes** — version tags
   are immutable (DEC-2), so a conflict refuses, naming both digests. An
   existing identical digest is a safe no-op republish.
5. A layer's base is already published: its base record's tag resolves to
   that record's `digest`.
6. After the push, `oras resolve` must still name the recorded digest — the
   registry-visible witness.

### Rehearsing on a local registry

```sh
python3 scripts/dev-registry/registry.py --port 5055 --dir <a dir outside the repo> &
scripts/publish-method-env-images.sh --registry 127.0.0.1:5055 --base base-py \
  --manifest <manifest> --staging-dir "$TXR_ENV_BUILD_DIR"
scripts/publish-method-env-images.sh --registry 127.0.0.1:5055 --env <id> \
  --manifest <manifest> --staging-dir "$TXR_ENV_BUILD_DIR"
```

`--registry` takes exactly `127.0.0.1:<port>` or `[::1]:<port>` (no hostnames,
not even `localhost`). Every oras call then goes to that host over plain HTTP
(`ghcr.io/` in the manifest's refs replaced by the loopback host, the same
mapping as the app's debug `TXR_METHOD_ENV_REGISTRY`); no login, no
credentials, no signing. The checks are the release path's. A debug app
started with `TXR_METHOD_ENV_REGISTRY=127.0.0.1:5055` and
`TXR_ENV_MANIFEST=<manifest>` then downloads from it.

### Why the push is `blob push` + `manifest push`, not `oras push`

The manifest entry's `digest` is the sha256 of the **exact** OCI artifact
manifest bytes the writer staged (`oci-manifest.json`, construction pinned in
design §6.1). `oras push`'s pack path does not store those bytes: oras-go sets
`org.opencontainers.image.created` to the current wall-clock time when it is
not supplied and serializes annotation maps with sorted keys, so the digest
would change from push to push. The publisher therefore pushes the staged
bytes verbatim — `oras blob push` for the layer and the OCI empty config,
then `oras manifest push` for the manifest file itself (tagged as-is). The
recorded digest is the pushed digest by construction, and the `resolve`
witness on every publish confirms it. (Recorded as ITEM-5 in
`.lifecycle/txresbench-app/method-env-images/DRIFT-1.md`.)

### Cross-arch builds are refused

`--arch` decides the tag, so a layer built on the wrong host is refused
unless `ALLOW_EMULATED_BUILD=1`; published arch is amd64 for now (D09), arm64
entries join from a native arm64 build host (DEC-10). Each entry records its
arch and the publisher refuses an `--arch` that disagrees with the entry.

### Signing

Layers are cosign-signed (provenance floor; the manifest sha256 is the
verification floor, DEC-5 / D04). Off CI, `cosign sign` uses **your** keyless
identity, not a CI OIDC identity — the app's verification policy (owner's
DEC-5 pick) decides what the runtime accepts, so sign with an identity that
policy trusts, or sign with an explicit key (`cosign sign --key`). `--skip-sign`
is for a runtime with verification disabled only, **never** for a layer a
published result depends on.

---

## 4. Adding a method or bumping a version

A new layer is a **build event**, not a publish-time edit. One method is
built and listed alone; every other entry of the list stays as it is.

1. Commit the method in `txresbench-methods` (method folder + its passed
   `gates/<id>.json`). The build refuses a method folder that is not
   committed, has uncommitted changes or untracked files, or has not passed
   its gate: the layer is built from the committed folder (`git archive`),
   and the list records that commit (`source_revision`) and the folder's git
   tree (`source_tree`). Every fact (version, language, licence, contract) is
   read from the method's own files at that commit; `index.json` is not read.
   Rebuilding the same version (a package fix) is fine: the tag ends with the
   layer file's hash, so a changed file gets its own tag; an unchanged file
   (generator 0.6.0+: layers pack reproducibly) is the same artifact, the same
   tag and digest.
2. Build the layer on the machine that holds the method's **pinned base
   image** (amd64: the workspace; arm64: the Mac's Colima build VM), into a
   fresh build dir:

   ```sh
   python3 scripts/generate-method-env-images.py --only <id> --arch <amd64|arm64> \
     --methods-dir <methods checkout> --out <fresh build dir>
   ```

   The base is the Docker image the committed list pins (`bases[]`
   `source_ref` + `source_digest`; `--base-pins <list>` for another list),
   taken from the local image store **by digest**: the generator never pulls
   a base (the base images are not published) and never rebuilds one (a
   rebuilt base has another digest). When the image is not on the machine it
   refuses with `BUILD_BASE_UNAVAILABLE`. A base image moves between machines
   only by `docker save` / `docker load`, and its digest is checked after the
   load:

   ```sh
   docker save ghcr.io/tinnlab/txresbench-base-py:2.0 -o base-py.tar        # where it is
   docker load -i base-py.tar                                                # where it goes
   docker image inspect --format '{{json .RepoDigests}}' ghcr.io/tinnlab/txresbench-base-py:2.0
   # must list ghcr.io/tinnlab/txresbench-base-py@<the list's source_digest>
   ```

3. Add the record to the list (assemble only, no docker). The previous
   list's entries and bases are carried byte for byte; the record replaces or
   adds its entry. Then the guard, against the list it changes:

   ```sh
   git show origin/main:src-app/server/data/method-env-images.json > previous.json
   python3 scripts/generate-method-env-images.py --assemble <build dir> \
     --methods-dir <methods checkout> --previous previous.json \
     --manifest src-app/server/data/method-env-images.json
   scripts/check-method-env-images.sh --staging-dir <build dir> \
     --methods-dir <methods checkout> --previous previous.json
   ```

   `--drop <env_id>-<arch>` removes an entry. A record built on another base
   image than the list pins is refused (`ASSEMBLE_BASE_CHANGED`). Writing a
   manifest needs `--previous` or `--full`, so a one-method list is never
   written by accident.
4. Publish, rehearsing with `--dry-run` first, against the previously
   published list (the list before this change): the publisher checks that
   the pushed entry equals its own build record, that its facts hold in the
   methods repository at its commit, that every other entry is byte-identical
   to the previous list (or re-assembles from its record in the build dir),
   and that the whole list passes every structural rule:

   ```sh
   scripts/publish-method-env-images.sh --env <id> --arch <arch> \
     --staging-dir <build dir> --methods-dir <methods checkout> \
     --previous previous.json
   ```

   Without `--previous` the publisher runs the whole-list check of a full
   rebuild (§5): every entry must re-assemble from the build dir.

### A new base image is a batch

A new base image (a base recipe change) is the base and **every layer on
it**, together: build them all with `--new-base` into one build dir (it
stages the base too), then assemble with `--replace-base <base_id>-<arch>`:

```sh
python3 scripts/generate-method-env-images.py --new-base --arch <arch> \
  --methods-dir <methods checkout> --out <build dir>            # every gated method of that language
python3 scripts/generate-method-env-images.py --assemble <build dir> \
  --methods-dir <methods checkout> --previous previous.json \
  --replace-base base-py-<arch> --manifest src-app/server/data/method-env-images.json
```

The writer refuses while an entry on the old image is still in the list
(`ASSEMBLE_BASE_BATCH`): rebuild it in the batch or `--drop` it. The first
entries of a new arch are such a batch too (the list pins no base for them
yet). A new base FILE packed from the same image (`--stage-bases`) keeps
every layer: they pair with the image, not the file. Publish the base first
(`--base <base_id> --arch <arch> --previous previous.json`), then each layer.

### Checking a list without a build dir

The provenance check needs only the methods repository: every entry's facts
are re-read at the entry's own commit (version, language, licence, FROM and
contract, wrapper hash, folder tree, gate).

```sh
scripts/check-method-env-images.sh --methods-dir <methods checkout> --require-provenance
```

### After the PR

1. Open a PR with the regenerated `src-app/server/data/method-env-images.json`;
   the next app release carries it (§6).
2. Never push a tag by hand with raw `oras` or `docker`: the publisher's checks
   are what refuses an overwrite. Never re-use or delete a tag that an app
   release still names: installed apps resolve that tag, then fetch the
   recorded digest.
3. Never delete a published layer or base version, even after a newer one
   replaces it in the list. A saved model runs in the exact image it was
   trained in, and the app fetches that file by its sha256 from the package
   (design §2); a deleted version can take its blob with it, and every model
   trained in it then cannot run on a computer that has not cached it.
4. A tag overwritten by mistake: GHCR keeps the old manifest as an untagged
   version, so point the tag back at the digest the manifest records (the
   entry's `digest`; a base: its `bases[]` record's `digest` in
   `ghcr.io/tinnlab/txresbench-env`), then check it:

   ```sh
   echo "$GHCR_TOKEN" | oras login ghcr.io -u "$GHCR_USER" --password-stdin
   oras tag ghcr.io/tinnlab/txr-method-env-layers@<digest> <tag>
   oras resolve ghcr.io/tinnlab/txr-method-env-layers:<tag>   # must print <digest>
   ```

---

## 5. Publishing the whole set

A full generation run (`--new-base`, every gated method, written with
`--full`) produces the staged records and the committed manifest for every
runnable method of one arch (amd64; arm64 from a native arm64 host).
Publishing is then one invocation per base, then one per method; without
`--previous` each one checks the whole list against the build dir:

```sh
for base in base-py base-r; do
  scripts/publish-method-env-images.sh --base "$base" --staging-dir <build dir> \
    --methods-dir <methods checkout> \
    --manifest src-app/server/data/method-env-images.json || break
done
for id in <the ids from the manifest — or the generator's summary list>; do
  scripts/publish-method-env-images.sh --env "$id" --staging-dir <build dir> \
    --methods-dir <methods checkout> \
    --manifest src-app/server/data/method-env-images.json \
    || break   # each refusal names its cause; never force past one
done
```

Each refusal is a hard stop: same-revision rebuilds are cheap, `--dry-run`
rehearsals are cheap, and a half-published set with a mismatched manifest
contract is not recoverable from a clinician's machine. If a layer cannot be
published (a size blow-up, a system-library delta the layer contract refuses
— see design §5.2), publish the rest and record the exclusion to the owner;
never weaken the contract to fit a method.

---

## 6. How the app picks up new layers

The manifest is the only runtime-facing artifact of this node: it is embedded
into the app at build time (DEC-6, `include_dir!` — dev builds read it from
disk). Publishing a layer alone changes nothing for an existing install; the
sequence is:

1. regenerate + commit the manifest (digests of the new layers),
2. build + release the app (the next app build embeds it),
3. on a clinician's machine, the runtime downloads a missing layer exactly
   once (by digest, verified by sha256, then offline), and a saved model
   records the two file hashes of its environment (INV-6); a later reuse runs
   in that image, fetching the file by its sha256 when the list has moved on
   (design §2), which is why no published version is ever deleted (§4).

Because tags are immutable and the manifest is digest-pinned, an app release
and the layers it advertises cannot drift apart after the fact: the bytes a
digest names never change.

---

## 7. Quick reference

```sh
# build one method, on the machine that holds its pinned base (§4), into a fresh build dir
python3 scripts/generate-method-env-images.py --only <id> --arch <amd64|arm64> \
  --methods-dir <methods checkout> --out <build dir>

# add it to the list: every other entry is carried byte for byte from the previous list
git show origin/main:src-app/server/data/method-env-images.json > previous.json
python3 scripts/generate-method-env-images.py --assemble <build dir> \
  --methods-dir <methods checkout> --previous previous.json \
  --manifest src-app/server/data/method-env-images.json

# validate (gate; the publisher runs it too)
scripts/check-method-env-images.sh --staging-dir <build dir> \
  --methods-dir <methods checkout> --previous previous.json

# a full rebuild instead: --full in place of --previous (whole-list parity, §5)

# stage the bases of layers already in a build dir
python3 scripts/generate-method-env-images.py --stage-bases --out <dir> --arch <arch>

# rehearse — prints the whole sequence, verifies every local byte, no network
scripts/publish-method-env-images.sh --base base-py --dry-run
scripts/publish-method-env-images.sh --env <id> --arch <arch> --staging-dir <build dir> \
  --methods-dir <methods checkout> --previous previous.json --dry-run

# rehearse for real on a local registry (plain HTTP, no login, no signing)
scripts/publish-method-env-images.sh --registry 127.0.0.1:5055 --base base-py

# publish (owner-gated; requires GHCR_TOKEN + GHCR_USER): bases first
scripts/publish-method-env-images.sh --base base-py
scripts/publish-method-env-images.sh --env <id> --arch <arch> --staging-dir <build dir> \
  --methods-dir <methods checkout> --previous previous.json

# skip signing — only against a runtime with verification disabled
scripts/publish-method-env-images.sh --env <id> --skip-sign
```
