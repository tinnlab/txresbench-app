#!/usr/bin/env bash
#
# publish-method-env-images.sh — owner-gated publisher for one per-method
# environment layer artifact (plan node method-env-images, ITEM-5).
#
# ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────
# The generator (ITEM-2) builds and stages, the manifest writer (ITEM-3)
# commits the contract; NOTHING in that pipeline publishes. The publish step is
# owner-gated by decision (STATUS.md / DEC-2: the owner publishes; no GitHub
# Actions exist in this repository — the app-epic build runs entirely on this
# machine and the framework's CI workflows are parked). Without a manual path,
# the per-method layers the runtime downloads would exist nowhere, and the
# "download state for environments" the app promises would be a design board
# and nothing more. This script is the manual path, mirroring
# `scripts/publish-env-rootfs.sh` (the framework's proven publish sequence:
# login → push → cosign sign, `--dry-run`, `--env`, `--arch`, `--skip-sign`,
# refuse cross-arch builds) with the differences the layer contract requires
# (below).
#
# ── WHAT IT PUBLISHES, AND WHY THE PUSH SHAPE IS TWO COMMANDS ──────────────────
# One artifact per invocation: the layer for one (env_id, arch), at
# `<oci_ref>:<tag>` (tag = `<method_version>-<arch>`, DEC-2's IMMUTABLE tag —
# there is deliberately NO moving tag: DEC-7 resolves layers by digest from the
# manifest, and screen F's size/progress rows need the manifest, not a tag).
#
# The manifest entry's `digest` is the sha256 of the EXACT OCI artifact
# manifest bytes the writer staged as `oci-manifest.json` (design §6.1). The
# publisher, therefore, does NOT use `oras push --artifact-type`: oras's own
# pack path re-serializes the manifest with `org.opencontainers.image.created`
# set to the CURRENT TIME and its annotation map keys reordered (oras-go
# `pack.go`'s `ensureAnnotationCreated` + Go's sorted map marshaling — pinned
# by the oras-go source review in DRIFT-1 ITEM-5), so the pushed bytes would
# differ from the staged bytes and from every previous push of the same layer,
# which is exactly the "byte-exactness surfaces at ITEM-5" seam the design
# warns about. Instead the publisher pushes the staged bytes VERBATIM:
#
#   oras blob push    <oci_ref>  layer.squashfs        # the layer blob
#   oras blob push    <oci_ref>  <empty-config.json>   # the OCI empty config
#   oras manifest push <oci_ref>:<tag> oci-manifest.json
#
# `oras manifest push` tags the manifest FILE bytes as-is (no re-marshal, no
# timestamp injection), so the recorded digest is the pushed digest BY
# CONSTRUCTION — version-of-oras independent, and the `oras resolve` verify
# below witnesses it on every publish instead of on the one that happens to
# match a given oras serialization.
#
# ── WHAT IT CHECKS BEFORE ANYTHING REACHES THE REGISTRY ────────────────────────
#   1. THE MANIFEST IS THE COMMITTED CONTRACT — the entry is read from
#      `src-app/server/data/method-env-images.json` (`--manifest` overridable),
#      and that file must satisfy the repo's own guard
#      (`scripts/check-method-env-images.sh`, regen-parity leg included against
#      the same staging dir): a hand-edited manifest that the guard refuses is
#      not published from.
#   2. THE STAGED ARTIFACT IS THE ENTRY'S BYTES — the layer file's sha256 and
#      size equal `layer_sha256`/`size_bytes`; the staged `oci-manifest.json`
#      hashes to the entry's `digest`; the build record
#      (`artifact.json` — env/method/version/arch/ref/tag/revision/hashes)
#      agrees field-for-field with the entry. A stray file finger is refused,
#      never "fixed" (the layer bytes are the bytes the runtime will verify
#      offline against this manifest).
#   3. THE BEHAVIORAL VERIFY HOOK — `scripts/lib/method-env-verify.sh`
#      (ITEM-7) is sourced when present and its
#      `txr_method_env_verify_layer <layer-dir> <artifact.json>` runs before
#      login/push; a non-zero exit refuses the publish (TEST-8). Until that
#      library exists the publisher prints an explicit skip-with-reason and
#      relies on checks 1-2 — never silently claiming a verification it did
#      not run.
#   4. THE TAG IS NOT OVERWRITTEN WITH DIFFERENT BYTES — version tags are
#      immutable (DEC-2): if `oras resolve <oci_ref>:<tag>` already names a
#      digest, it must equal the entry's `digest`, or the publish REFUSES
#      naming both. Same digest = same bytes = safe no-op publish.
#   5. AFTER THE PUSH, `oras resolve` must still name the recorded digest —
#      the registry-visible end-to-end witness; a mismatch refuses (naming
#      both digests) rather than reporting success over a divergent artifact.
#
# ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────────
#   * It does not BUILD. The build is ITEM-2's generator; this script
#     consumes the staged artifact and verifies it (the plan's PROV-5
#     publisher spec names login/push/tag/sign — the "build/verify" of the
#     ITEM-5 paragraph is the pipeline's build step, not a second build in the
#     publisher; PLAN note r).
#   * It does not run the method or mount the layer (ITEM-7's equivalence
#     test is the behavioral arbiter; the hook above calls its verifier).
#   * It does not touch the methods repository (read-only build input) and
#     does not edit the manifest (a new version's layer is a regeneration +
#     a new manifest commit, never a push-time patch — INV-5).
#   * It never touches the benchmark base images: a layer's `base_ref`/
#     `base_digest` record where the delta was computed against; the runtime's
#     trimmed base is sandbox-stacked's artifact, paired by the digest anchor
#     (DEC-4) — not this publisher's concern.
#
# ── WHAT YOU NEED ──────────────────────────────────────────────────────────────
#   * docker + the generator's staged build output (TXR_ENV_BUILD_DIR), oras
#     (>= 1.2, tested against the `manifest push` + `blob push` subcommands),
#     cosign (>= 2.4) unless `--skip-sign`.
#   * a GHCR token with `write:packages` in GHCR_TOKEN, and GHCR_USER. The
#     registry host is ghcr.io and the namespace is tinnlab/txr-method-env-layers
#     (DEC-2, owner-confirmed D05, already in scripts/network-allowlist.txt);
#     the entry's oci_ref is authoritative and is REFUSED if it leaves that
#     namespace — no runtime would ever fetch it.
#   * signing identity per DEC-5 (owner's decided verification policy; see the
#     runbook's "Signing" section). Off CI cosign signs with YOUR identity —
#     the decomposition accepts, or use `--skip-sign` only against a runtime
#     with verification disabled (never for a published result).
#
# ── USAGE ──────────────────────────────────────────────────────────────────────
#   scripts/publish-method-env-images.sh --env <env_id> [--arch amd64|arm64]
#                                       [--manifest <path>] [--staging-dir <dir>]
#                                       [--methods-dir <dir>]
#                                       [--dry-run] [--skip-sign]
#
# `--env` is REQUIRED (one invocation = one (env, arch) artifact; nothing
# defaults across 95 methods). `--staging-dir` defaults to $TXR_ENV_BUILD_DIR.
#
# Exit: 0 published (or dry-run complete); 1 a refusal — artifact bytes
# inconsistent, manifest red, tag already holds different bytes, post-push
# digest mismatch, behavioral-verify failure; 2 usage/tooling — bad flag,
# unknown (env, arch), cross-arch build without ALLOW_EMULATED_BUILD=1,
# missing files or tools or login credentials.

set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)

REGISTRY=ghcr.io
OCI_REF_PREFIX="ghcr.io/tinnlab/txr-method-env-layers"
# The layer's OCI artifact type (application/vnd.txr.method-env.layer.v1) is
# carried inside the staged artifact-manifest bytes — the publisher never
# spell it on a command line; it is stated here because it is the byte
# contract's media type (design §6).
ARTIFACT_TYPE=application/vnd.txr.method-env.layer.v1
# The OCI empty-JSON config blob the artifact manifest references (the
# image-spec's pinned empty descriptor: `{}`, sha256 44136fa3...). The
# publisher materializes it next to the manifest so `oras blob push` can
# upload it — registries reject a manifest whose referenced config blob is
# absent, and this is exactly what oras's own pack path pushes first.
EMPTY_CONFIG_DIGEST=sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a

ENV_ID=""
ARCH=amd64
MANIFEST="$REPO_ROOT/src-app/server/data/method-env-images.json"
STAGING="${TXR_ENV_BUILD_DIR:-}"
METHODS_DIR="${TXR_METHODS_DIR:-}"
DRY_RUN=0
SKIP_SIGN=0
VERIFY_LIB="$REPO_ROOT/scripts/lib/method-env-verify.sh"

usage() {
  sed -n '2,121p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_ID=$2; shift 2 ;;
    --arch) ARCH=$2; shift 2 ;;
    --manifest) MANIFEST=$2; shift 2 ;;
    --staging-dir) STAGING=$2; shift 2 ;;
    --methods-dir) METHODS_DIR=$2; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-sign) SKIP_SIGN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$ENV_ID" ] || { echo "publish: --env <env_id> is required (one artifact per invocation)" >&2; exit 2; }
case "$ARCH" in
  amd64|arm64) ;;
  *) echo "publish: unsupported --arch: $ARCH (expected amd64 or arm64)" >&2; exit 2 ;;
esac

# ── refuse a cross-arch publish (mirror of publish-env-rootfs.sh) ──────────────
# `--arch` DECIDES THE TAG, so it must decide what could have been built; a
# qemu-built layer (native libs under emulation) is not something to publish
# under a native arch tag that a clinician's mac/linux then fetches. Demand a
# native host, or ALLOW_EMULATED_BUILD=1 + full intent.
HOST_ARCH=$(uname -m)
case "$HOST_ARCH" in
  x86_64|amd64) HOST_DOCKER_ARCH=amd64 ;;
  aarch64|arm64) HOST_DOCKER_ARCH=arm64 ;;
  *) HOST_DOCKER_ARCH=unknown ;;
esac
if [ "$ARCH" != "$HOST_DOCKER_ARCH" ] && [ "${ALLOW_EMULATED_BUILD:-0}" != "1" ]; then
  echo "refusing to publish a $ARCH layer from a $HOST_DOCKER_ARCH host." >&2
  echo "Build the layer natively for $ARCH (what the generator's own cross-arch" >&2
  echo "refusal demands, ITEM-2), or set ALLOW_EMULATED_BUILD=1 if you have qemu" >&2
  echo "configured and mean it." >&2
  exit 2
fi

# ── 1. read the committed contract ─────────────────────────────────────────────
# The entry is authoritative: oci_ref, tag, digest, layer_sha256, size_bytes,
# base_ref, base_digest, contract, source_revision all come from the manifest,
# never from the operator's flags or the record (the record is re-verified
# against the entry below; the manifest is the runtime's contract).
if [ ! -f "$MANIFEST" ]; then
  echo "publish: no manifest at $MANIFEST" >&2; exit 2
fi
entry=$(python3 - "$MANIFEST" "$ENV_ID" "$ARCH" <<'PYEOF'
import json, sys
manifest_path, env_id, arch = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(manifest_path, "rb") as f:
        m = json.load(f)
except Exception as e:
    print(f"publish: {manifest_path} is not valid JSON: {e}", file=sys.stderr)
    sys.exit(2)
key = (env_id, arch)
for e in m.get("envs", []):
    if (e.get("env_id"), e.get("arch")) == key:
        row = [e.get(f, "") for f in (
            "env_id", "method_id", "method_version", "language", "arch",
            "oci_ref", "tag", "digest", "layer_sha256", "size_bytes",
            "base_ref", "base_digest", "contract", "layer_schema")]
        row.append(m.get("source_revision", ""))
        print("\t".join(str(v) for v in row))
        sys.exit(0)
print(f"publish: no manifest entry for {env_id}-{arch}; available: "
      + ", ".join(f"{e.get('env_id')}-{e.get('arch')}" for e in m.get("envs", []))
      or "(none — the manifest has no entries yet)", file=sys.stderr)
sys.exit(2)
PYEOF
) || exit $?
IFS=$'\t' read -r ENTRY_ENV_ID ENTRY_METHOD_ID ENTRY_METHOD_VERSION ENTRY_LANGUAGE \
  ENTRY_ARCH ENTRY_OCI_REF ENTRY_TAG ENTRY_DIGEST ENTRY_LAYER_SHA256 ENTRY_SIZE_BYTES \
  ENTRY_BASE_REF ENTRY_BASE_DIGEST ENTRY_CONTRACT ENTRY_LAYER_SCHEMA ENTRY_SOURCE_REVISION \
  <<< "$entry"

# The manifest is the runtime contract; the namespace is DEC-2's and the host
# is the allowlisted one (DEC-17: scheme-less refs, no new host anywhere).
if [ "$ENTRY_OCI_REF" != "$OCI_REF_PREFIX/$ENTRY_ENV_ID" ]; then
  echo "refusing: entry oci_ref $ENTRY_OCI_REF is not $OCI_REF_PREFIX/<env_id>" >&2
  echo "The runtime fetches exactly this ref (DEC-2 namespace, owner-confirmed" >&2
  echo "D05); publishing anywhere else would be unfetchable by the app." >&2
  exit 1
fi
if [ "$ENTRY_ARCH" != "$ARCH" ]; then
  echo "publish: --arch $ARCH does not match the manifest entry's arch $ENTRY_ARCH" >&2
  echo "(the entry's tag is $ENTRY_TAG; publish with --arch $ENTRY_ARCH)." >&2
  exit 2
fi

echo "env       : $ENTRY_ENV_ID"
echo "method    : $ENTRY_METHOD_ID $ENTRY_METHOD_VERSION ($ENTRY_LANGUAGE)"
echo "artifact  : $ENTRY_OCI_REF:$ENTRY_TAG"
echo "digest    : $ENTRY_DIGEST   (manifest entry — the runtime's fetch unit)"
echo "layer     : sha256 $ENTRY_LAYER_SHA256, $ENTRY_SIZE_BYTES bytes, schema $ENTRY_LAYER_SCHEMA"
echo "base      : $ENTRY_BASE_REF @ $ENTRY_BASE_DIGEST   (provenance, DEC-4)"
echo "revision  : $ENTRY_SOURCE_REVISION   (methods repo — the layer's source)"

# ── 2. locate the staged artifact ──────────────────────────────────────────────
if [ -z "$STAGING" ]; then
  echo "publish: no staging dir. Build first (scripts/generate-method-env-images.py" >&2
  echo "--only $ENTRY_ENV_ID --manifest <path>) or pass --staging-dir /" >&2
  echo "TXR_ENV_BUILD_DIR (the build output, not a repo directory)." >&2
  exit 2
fi
LAYER_DIR="$STAGING/layers/$ENTRY_ENV_ID-$ENTRY_ARCH"
SQUASHFS="$LAYER_DIR/layer.squashfs"
RECORD="$LAYER_DIR/artifact.json"
OCI_MANIFEST="$LAYER_DIR/oci-manifest.json"
for f in "$SQUASHFS" "$RECORD" "$OCI_MANIFEST"; do
  [ -f "$f" ] || { echo "publish: staging artifact missing $f (rebuild the layer)" >&2; exit 2; }
done
[ -s "$SQUASHFS" ] || { echo "publish: $SQUASHFS is empty" >&2; exit 2; }

# ── 3. the bytes are the entry's bytes (INV-4: offline-verifiable, then used) ──
# Every refusal below names the file and the expected value; nothing is
# normalized. The layer the runtime will fetch is these exact bytes, and the
# manifest records THEM — a mismatch means a divergent artifact, full stop.
actual_sha=$(sha256sum "$SQUASHFS" | awk '{print $1}')
actual_size=$(wc -c < "$SQUASHFS" | tr -d ' ')
if [ "$actual_sha" != "$ENTRY_LAYER_SHA256" ]; then
  echo "refusing: layer.squashfs sha256 $actual_sha != manifest layer_sha256 $ENTRY_LAYER_SHA256" >&2
  echo "The staged bytes differ from what the contract declares (INV-4); rebuild at" >&2
  echo "the recorded revision and regenerate the manifest — never hand-edit either." >&2
  exit 1
fi
if [ "$actual_size" != "$ENTRY_SIZE_BYTES" ]; then
  echo "refusing: layer.squashfs is $actual_size bytes, manifest size_bytes is $ENTRY_SIZE_BYTES" >&2
  exit 1
fi
actual_digest="sha256:$(sha256sum "$OCI_MANIFEST" | awk '{print $1}')"
if [ "$actual_digest" != "$ENTRY_DIGEST" ]; then
  echo "refusing: staged oci-manifest.json digest $actual_digest != manifest digest $ENTRY_DIGEST" >&2
  echo "The artifact-manifest bytes the entry pins are not what is staged" >&2
  echo "(design §6.1); regenerate the manifest from this staging dir — the writer" >&2
  echo "stages the exact bytes it pins, so a rebuild is the only repair." >&2
  exit 1
fi
record=$(python3 - "$RECORD" <<'PYEOF'
import json, sys
try:
    with open(sys.argv[1], "rb") as f:
        r = json.load(f)
except Exception as e:
    print(f"publish: {sys.argv[1]} is not valid JSON: {e}", file=sys.stderr)
    sys.exit(2)
print("\t".join(str(r.get(f, "")) for f in (
    "env_id", "method_id", "method_version", "arch", "oci_ref", "tag",
    "layer_sha256", "size_bytes", "source_revision", "layer_file")))
PYEOF
) || exit $?
IFS=$'\t' read -r REC_ENV_ID REC_METHOD_ID REC_METHOD_VERSION REC_ARCH REC_OCI_REF REC_TAG \
  REC_LAYER_SHA256 REC_SIZE_BYTES REC_SOURCE_REVISION REC_LAYER_FILE <<< "$record"
# Field-for-field record/entry agreement (the writer's note-m validation again,
# at the boundary that matters: the bytes about to be published).
rec_ok=1
[ "$REC_ENV_ID" = "$ENTRY_ENV_ID" ] || { echo "refusing: record env_id $REC_ENV_ID != entry $ENTRY_ENV_ID" >&2; rec_ok=0; }
[ "$REC_METHOD_ID" = "$ENTRY_METHOD_ID" ] || { echo "refusing: record method_id $REC_METHOD_ID != entry $ENTRY_METHOD_ID" >&2; rec_ok=0; }
[ "$REC_METHOD_VERSION" = "$ENTRY_METHOD_VERSION" ] || { echo "refusing: record method_version $REC_METHOD_VERSION != entry $ENTRY_METHOD_VERSION" >&2; rec_ok=0; }
[ "$REC_ARCH" = "$ENTRY_ARCH" ] || { echo "refusing: record arch $REC_ARCH != entry $ENTRY_ARCH" >&2; rec_ok=0; }
[ "$REC_OCI_REF" = "$ENTRY_OCI_REF" ] || { echo "refusing: record oci_ref $REC_OCI_REF != entry $ENTRY_OCI_REF" >&2; rec_ok=0; }
[ "$REC_TAG" = "$ENTRY_TAG" ] || { echo "refusing: record tag $REC_TAG != entry $ENTRY_TAG" >&2; rec_ok=0; }
[ "$REC_LAYER_SHA256" = "$ENTRY_LAYER_SHA256" ] || { echo "refusing: record layer_sha256 $REC_LAYER_SHA256 != entry $ENTRY_LAYER_SHA256" >&2; rec_ok=0; }
[ "$REC_SIZE_BYTES" = "$ENTRY_SIZE_BYTES" ] || { echo "refusing: record size_bytes $REC_SIZE_BYTES != entry $ENTRY_SIZE_BYTES" >&2; rec_ok=0; }
[ "$REC_SOURCE_REVISION" = "$ENTRY_SOURCE_REVISION" ] || { echo "refusing: record source_revision $REC_SOURCE_REVISION != entry $ENTRY_SOURCE_REVISION" >&2; rec_ok=0; }
[ "$REC_LAYER_FILE" = "layer.squashfs" ] || { echo "refusing: record layer_file $REC_LAYER_FILE != layer.squashfs" >&2; rec_ok=0; }
[ "$rec_ok" = "1" ] || { echo "refusing: the build record disagrees with the manifest entry —" >&2; echo "rebuild/regenerate (one revision, one manifest); never reconcile by hand." >&2; exit 1; }

# ── 4. the committed manifest must satisfy the repo's own guard ────────────────
# The guard is the manifest validator (ITEM-4); the publisher runs it against
# the SAME staging dir so its regen-parity leg rules too (publishing from a
# manifest whose records no longer reassemble is the INV-5 violation the guard
# exists to catch — and the publisher is exactly the machine the parity leg
# was designed for: it has the docker-build-produced hashes). Local + fast, so
# it runs in --dry-run too: a rehearsal that skips the manifest contract is a
# rehearsal of nothing.
GUARD="$REPO_ROOT/scripts/check-method-env-images.sh"
guard_args=(--manifest "$MANIFEST" --staging-dir "$STAGING")
[ -z "$METHODS_DIR" ] || guard_args+=(--methods-dir "$METHODS_DIR")
echo "+ scripts/check-method-env-images.sh ${guard_args[*]}"
set +e
"$GUARD" "${guard_args[@]}" >/dev/null
rc=$?
set -e
if [ "$rc" = "1" ]; then
  echo "refusing: scripts/check-method-env-images.sh rejects the manifest (run it to see why)." >&2
  echo "A manifest the guard refuses is not published from; fix the staging/regeneration." >&2
  exit 1
fi
if [ "$rc" != "0" ]; then
  echo "publish: the manifest guard exited $rc (usage/missing file); re-check paths." >&2
  exit 2
fi
echo "guard     : manifest + regen parity OK"

# ── 4b. behavioral verify hook (ITEM-7's scripts/lib/method-env-verify.sh) ─────
# Contract: the library defines `txr_method_env_verify_layer LAYER_DIR
# RECORD_FILE`; non-zero exit refuses the publish (TEST-8). Until the library
# ships, this prints an honest skip-with-reason — checks 1-3 above are the
# byte contract, the behavioral equivalence is ITEM-7's arbiter (EX-7).
if [ -f "$VERIFY_LIB" ]; then
  # shellcheck source=lib/method-env-verify.sh
  . "$VERIFY_LIB"
  if [ "$DRY_RUN" = "1" ]; then
    echo "+ txr_method_env_verify_layer $LAYER_DIR $RECORD   # behavioral verify"
  else
    if ! txr_method_env_verify_layer "$LAYER_DIR" "$RECORD"; then
      echo "refusing: the behavioral verifier failed for $ENTRY_ENV_ID-$ENTRY_ARCH." >&2
      echo "An artifact that does not meet the layer contract is not published (TEST-8)." >&2
      exit 1
    fi
    echo "verify    : behavioral verifier OK"
  fi
else
  echo "!! SKIPPED: $VERIFY_LIB does not exist yet (ITEM-7 ships it)."
  echo "!! The byte contract above is verified; behavioral equivalence is ITEM-7's."
fi

# ── 5. login ───────────────────────────────────────────────────────────────────
run() {
  echo "+ $*"
  [ "$DRY_RUN" = "1" ] || "$@"
}

if [ "$DRY_RUN" = "1" ]; then
  echo "+ oras login $REGISTRY -u \$GHCR_USER --password-stdin   # GHCR_TOKEN on stdin"
else
  missing=""
  [ -n "${GHCR_TOKEN:-}" ] || missing="$missing GHCR_TOKEN"
  [ -n "${GHCR_USER:-}" ] || missing="$missing GHCR_USER"
  if [ -n "$missing" ]; then
    echo "publish: set$missing (a GitHub token with write:packages + your username)" >&2
    exit 2
  fi
  command -v oras >/dev/null 2>&1 || { echo "publish: oras not found (need >= 1.2 for manifest push)" >&2; exit 2; }
  if [ "$SKIP_SIGN" != "1" ]; then
    command -v cosign >/dev/null 2>&1 || { echo "publish: cosign not found (or --skip-sign)" >&2; exit 2; }
  fi
  echo "$GHCR_TOKEN" | oras login "$REGISTRY" -u "$GHCR_USER" --password-stdin
fi

# ── 6. the overwrite refusal (immutable tags, DEC-2) ───────────────────────────
# If the tag already exists, it must name the SAME bytes — the same layer is
# byte-identical (INV-4), so an existing identical digest is a no-op publish;
# anything else means a previous artifact under this tag, which must not be
# shadowed silently. `resolve` failing here is treated as "tag absent" — the
# post-push verify below is the authoritative witness after a successful push.
if [ "$DRY_RUN" = "1" ]; then
  echo "+ oras resolve $ENTRY_OCI_REF:$ENTRY_TAG   # refuse on mismatch with $ENTRY_DIGEST"
else
  remote=$(oras resolve "$ENTRY_OCI_REF:$ENTRY_TAG" 2>/dev/null || true)
  if [ -n "$remote" ]; then
    if [ "$remote" != "$ENTRY_DIGEST" ]; then
      echo "refusing: the tag $ENTRY_TAG already exists at $remote, not the built $ENTRY_DIGEST." >&2
      echo "Version tags are immutable (DEC-2); a republish under the same version means" >&2
      echo "different bytes under a digest the runtime may already have fetched. Publish a" >&2
      echo "new method version (new tag) or deliberately delete the tag first." >&2
      exit 1
    fi
    echo "tag       : $ENTRY_TAG already names $ENTRY_DIGEST (identical bytes — re-publishing)"
  fi
fi

# ── 7. push the staged bytes verbatim ──────────────────────────────────────────
# blob(s) first — a registry refuses a manifest whose referenced blobs are
# absent — then the manifest bytes themselves, tagged. The layer blob is
# pushed from INSIDE the layer dir so oras records unstripped relative
# basename in the file store (the construction's title annotation);
# `oras manifest push` extracts the media type from the file and tags the
# bytes as-is: no re-serialization, no clock.
EMPTY_CONFIG="$STAGING/publish/empty-config.json"
mkdir -p "$STAGING/publish"
if [ ! -f "$EMPTY_CONFIG" ]; then
  printf '{}' > "$EMPTY_CONFIG"
fi
if [ "$(sha256sum "$EMPTY_CONFIG" | awk '{print $1}')" != "${EMPTY_CONFIG_DIGEST#sha256:}" ]; then
  echo "publish: $EMPTY_CONFIG is not the OCI empty JSON (sha256 != $EMPTY_CONFIG_DIGEST)" >&2
  exit 1
fi
if [ "$DRY_RUN" = "1" ]; then
  echo "+ oras blob push $ENTRY_OCI_REF $LAYER_DIR/layer.squashfs"
  echo "+ oras blob push $ENTRY_OCI_REF $EMPTY_CONFIG"
  echo "+ oras manifest push $ENTRY_OCI_REF:$ENTRY_TAG $OCI_MANIFEST"
else
  ( cd "$LAYER_DIR" && oras blob push "$ENTRY_OCI_REF" layer.squashfs )
  oras blob push "$ENTRY_OCI_REF" "$EMPTY_CONFIG"
  oras manifest push "$ENTRY_OCI_REF:$ENTRY_TAG" "$OCI_MANIFEST"
fi

# ── 8. the registry-visible witness ────────────────────────────────────────────
if [ "$DRY_RUN" = "1" ]; then
  echo "+ oras resolve $ENTRY_OCI_REF:$ENTRY_TAG   # must equal $ENTRY_DIGEST"
else
  pushed=$(oras resolve "$ENTRY_OCI_REF:$ENTRY_TAG")
  if [ "$pushed" != "$ENTRY_DIGEST" ]; then
    echo "refusing: post-push resolve $pushed != recorded $ENTRY_DIGEST." >&2
    echo "The registry now holds a manifest for this tag whose digest does not match the" >&2
    echo "manifest contract (design §6.1 — the pinned-construction check). Delete the tag," >&2
    echo "repair the construction (never by hand-edit) and regenerate + republish." >&2
    exit 1
  fi
  echo "published : $ENTRY_OCI_REF:$ENTRY_TAG @ $pushed"
fi

# ── 9. sign (provenance floor; the manifest sha256 is the verification floor) ──
if [ "$SKIP_SIGN" = "1" ]; then
  echo "!! SIGNING SKIPPED. A runtime whose verification policy is enabled will REFUSE"
  echo "!! to mount this layer. Use --skip-sign only against a deployment with"
  echo "!! verification disabled, and never for a layer a published result depends on."
else
  if [ "$DRY_RUN" = "1" ]; then
    echo "+ cosign sign --yes $ENTRY_OCI_REF@$ENTRY_DIGEST"
  else
    echo "NOTE: off CI, cosign signs with YOUR identity, not a CI OIDC identity."
    echo "See the runbook's signing section before relying on this in production"
    echo "(DEC-5: the app's verification policy decides what is accepted)."
    cosign sign --yes "$ENTRY_OCI_REF@$ENTRY_DIGEST"
  fi
fi

echo "done. The next app build embeds the regenerated manifest; the runtime fetches"
echo "$ENTRY_OCI_REF@$ENTRY_DIGEST and verifies $ENTRY_LAYER_SHA256 before mounting."
