# Runbook — publishing the per-method environment layers

Owner: whoever is publishing a method environment layer to
`ghcr.io/tinnlab/txr-method-env-layers/` after a build or a methods-revision
bump. The publish step is **owner-gated by decision** (D10 in
`.lifecycle/txresbench-app/OWNER-DECISIONS.md`: "Owner publishes, workers
rehearse"): no worker, no CI, no GitHub Action publishes a layer — this
document and `scripts/publish-method-env-images.sh` are the path.

---

## 0. Read this first: what is and is not automated

Nothing about the layers is published automatically. The app-epic build runs
entirely on the build machine; the framework's Actions workflows are parked
(billing) and the app repo adds none. The consequence is the same as for the
framework's env image, documented in
`docs/runbooks/env-image-republish.md` §0: a layer that exists only in a
staging directory is a layer no clinician can download.

What each step owns, and who may run it:

| step | tool | who |
|---|---|---|
| build a layer | `scripts/generate-method-env-images.py` | worker or owner (the pipeline) |
| assemble + commit the manifest | the same generator (`--manifest`) | worker (ITEM-6 commits it) |
| validate the committed manifest | `scripts/check-method-env-images.sh` | the gate (every commit) |
| publish a layer | `scripts/publish-method-env-images.sh` | **owner only** |
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
| the env manifest (the contract) | `src-app/server/data/method-env-images.json` (+ `.schema.json`) | the runtime's fetch/verify source; generated, never hand-edited (INV-5) |
| the manifest guard | `scripts/check-method-env-images.sh` | schema + structural validation + regen parity |
| the publisher | `scripts/publish-method-env-images.sh` | verify the staged bytes → login → push → verify the digest → sign |
| the behavioral verifier | `scripts/lib/method-env-verify.sh` (ITEM-7) | extracts the staged layer and verifies its artifact contract (marker, wrapper, modes, entries, `usr/` sentinel); EX-7's stacked equivalence is the Rust test's arbiter |
| the artifact contract (the design) | `docs/design/method-env-layer-artifacts.md` | delta semantics, trim rules, layer filesystem contract, the pinned OCI manifest bytes (§6/§6.1) |

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
ghcr.io/tinnlab/txr-method-env-layers/<id>:<version>-<arch>
```

Publish order matters: **base images first, layers second.** The layer is a
delta over the benchmark base image and records `base_ref`/`base_digest` as
provenance (DEC-4); the generator needs that base pullable (or builds it from
`dev/code/benchmark/docker-images/base-{r,py}/`). The app-side trimmed base
the runtime actually stacks is `sandbox-stacked`'s artifact and is paired by
the `com.txr.trimmed-from-digest` anchor — publishing layers is not
publishing bases.

---

## 3. Publishing one layer

Prerequisites: `docker` (for any build), `oras` ≥ 1.2 (needs the `blob push`
and `manifest push` subcommands), `cosign` ≥ 2.4 (unless `--skip-sign`), and
a GHCR token with `write:packages` for the
`tinnlab/txr-method-env-layers` namespace.

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
scripts/publish-method-env-images.sh --env <id> --dry-run \
  --manifest <manifest> --staging-dir "$TXR_ENV_BUILD_DIR"

# 4. publish
scripts/publish-method-env-images.sh --env <id> \
  --manifest <manifest> --staging-dir "$TXR_ENV_BUILD_DIR"
```

One invocation publishes exactly one (env, arch) artifact. `--env` is
required — nothing defaults across ~95 methods, and publishing the wrong
`<id>` under an immutable version tag is not a recoverable mistake.

### What the publisher verifies before anything reaches the registry

1. The manifest entry exists and the staged artifact's bytes are the entry's
   bytes: `sha256(layer.squashfs) == layer_sha256`, the size matches,
   `sha256(oci-manifest.json) == digest` (the pinned construction, design
   §6.1), and the build record agrees field-for-field with the entry.
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
   gate.
4. The version tag does not already hold **different bytes** — version tags
   are immutable (DEC-2), so a conflict refuses, naming both digests. An
   existing identical digest is a safe no-op republish.
5. After the push, `oras resolve` must still name the recorded digest — the
   registry-visible witness.

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

A new layer is a **generation event**, not a publish-time edit:

1. Check out the methods repository at the revision you are building from
   (the manifest records it as `source_revision`).
2. Build: `generate-method-env-images.py --only <id> --out … --manifest …`.
3. Assemble the full-set manifest from **all** staged records
   (`--fixture`/`--out` + `--manifest`): the parity check compares the whole
   set, so a partial staging dir cannot publish a new manifest (INV-5).
4. Run the guard; commit the regenerated manifest (the only in-repo output).
5. Publish the new (tag, digest) pair with this runbook; the old tag is left
   alone (immutable), an old digest stays fetchable forever.

The publisher's overwrite refusal is the safety net for a step-3 slip: an
existing tag with different bytes refuses instead of silently shadowing.

---

## 5. Publishing the whole set

ITEM-6's full generation run produces the staged records and the committed
manifest for every runnable method (amd64; arm64 from a native arm64 host).
Publishing is then one invocation per method:

```sh
for id in <the ids from the manifest — or the generator's summary list>; do
  scripts/publish-method-env-images.sh --env "$id" \
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
   records the environment's digest verbatim (INV-6) for exact provenance.

Because tags are immutable and the manifest is digest-pinned, an app release
and the layers it advertises cannot drift apart after the fact: the bytes a
digest names never change.

---

## 7. Quick reference

```sh
# build one method + assemble a manifest (staging dir = TXR_ENV_BUILD_DIR)
python3 scripts/generate-method-env-images.py --only <id> --manifest <manifest>

# validate (gate; the publisher runs it too)
scripts/check-method-env-images.sh --manifest <manifest> --staging-dir <dir>

# rehearse — prints the whole sequence, verifies every local byte, no network
scripts/publish-method-env-images.sh --env <id> --dry-run

# publish (owner-gated; requires GHCR_TOKEN + GHCR_USER)
scripts/publish-method-env-images.sh --env <id>

# skip signing — only against a runtime with verification disabled
scripts/publish-method-env-images.sh --env <id> --skip-sign
```
