#!/usr/bin/env bash
#
# publish-method-env-images.sh — owner-gated publisher for one method
# environment artifact: a per-method LAYER (plan node method-env-images,
# ITEM-5) or a per-language BASE (design §6.3).
#
# ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────
# The generator (ITEM-2) builds and stages, the manifest writer (ITEM-3)
# commits the contract; NOTHING in that pipeline publishes. The publish step is
# owner-gated by decision (STATUS.md / DEC-2: the owner publishes; no GitHub
# Actions exist in this repository — the app-epic build runs entirely on this
# machine and the framework's CI workflows are parked). Without a manual path,
# the bases and layers the runtime downloads would exist nowhere, and the
# "download state for environments" the app promises would be a design board
# and nothing more. This script is the manual path, mirroring
# the framework's env-image publish sequence (
# login → push → cosign sign, `--dry-run`, `--env`, `--arch`, `--skip-sign`,
# refuse cross-arch builds) with the differences the artifact contract requires
# (below).
#
# ── WHAT IT PUBLISHES, AND WHY THE PUSH SHAPE IS TWO COMMANDS ──────────────────
# One artifact per invocation:
#   --env <env_id>    the layer for one (env_id, arch), at `<oci_ref>:<tag>`
#                     (tag = `<method_version>-<arch>`, DEC-2's IMMUTABLE tag);
#   --base <base_id>  the base for one (base-py|base-r, arch), at the manifest
#                     `bases[]` record's `<oci_ref>:<tag>` (tag =
#                     `<contract>-<arch>-<first 12 hex of squashfs_sha256>`,
#                     immutable: one tag per distinct base file).
# There is deliberately NO moving tag: a new artifact reaches a clinician only
# through a new app build embedding the regenerated manifest.
#
# Bases first, then layers: a layer stacks on its base, so a layer publish
# REFUSES until its base's tag resolves to the base record's digest, and a
# manifest without a `bases` list (one from before the base publisher) is not
# published from at all — its layers could never run.
#
# The manifest's `digest` (an entry's, or a base record's) is the sha256 of the
# EXACT OCI artifact manifest bytes the writer staged as `oci-manifest.json`
# (design §6.1/§6.3). The publisher, therefore, does NOT use `oras push
# --artifact-type`: oras's own pack path re-serializes the manifest with
# `org.opencontainers.image.created` set to the CURRENT TIME and its annotation
# map keys reordered (oras-go `pack.go`'s `ensureAnnotationCreated` + Go's
# sorted map marshaling — pinned by the oras-go source review in DRIFT-1
# ITEM-5), so the pushed bytes would differ from the staged bytes and from
# every previous push of the same artifact. Instead the publisher pushes the
# staged bytes VERBATIM:
#
#   oras blob push    <oci_ref>  <the squashfs file>   # layer.squashfs | base.squashfs
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
#   1. THE MANIFEST IS THE COMMITTED CONTRACT — the entry or base record is read
#      from `src-app/server/data/method-env-images.json` (`--manifest`
#      overridable), and that file must satisfy the repo's own guard
#      (`scripts/check-method-env-images.sh`, regen-parity leg included against
#      the same staging dir): a hand-edited manifest that the guard refuses is
#      not published from. It must carry a `bases` list.
#   2. THE STAGED ARTIFACT IS THE MANIFEST'S BYTES — the squashfs file's sha256
#      and size equal the pin (`layer_sha256` / `squashfs_sha256`) and
#      `size_bytes`; the staged `oci-manifest.json` hashes to the `digest`; the
#      build record (`artifact.json`) agrees field-for-field. A stray file
#      finger is refused, never "fixed" (these bytes are the bytes the runtime
#      will verify offline against this manifest).
#   3. THE BEHAVIORAL CHECK — a layer: `scripts/lib/method-env-verify.sh`
#      (ITEM-7) is sourced when present and its
#      `txr_method_env_verify_layer <layer-dir> <artifact.json>` runs before
#      login/push; a non-zero exit refuses the publish (TEST-8). Until that
#      library exists the publisher prints an explicit skip-with-reason. A
#      base: `unsquashfs -lln` must list what the stacked run needs —
#      /opt/txr-layer (and /opt/txr-layer/R-library for base-r),
#      /usr/bin/prlimit and /usr/bin/bash (the sandbox makes /bin a link to
#      the base's usr/bin; links inside the base are followed).
#   4. THE TAG IS NOT OVERWRITTEN WITH DIFFERENT BYTES — tags are immutable:
#      if `oras resolve <oci_ref>:<tag>` already names a digest, it must equal
#      the manifest's `digest`, or the publish REFUSES naming both. Same digest
#      = same bytes = safe no-op publish.
#   5. A LAYER'S BASE IS ALREADY PUBLISHED — `oras resolve` of the paired base
#      record's `<oci_ref>:<tag>` must equal that record's `digest`.
#   6. AFTER THE PUSH, `oras resolve` must still name the recorded digest —
#      the registry-visible end-to-end witness; a mismatch refuses (naming
#      both digests) rather than reporting success over a divergent artifact.
#
# ── THE LOOPBACK REHEARSAL (--registry) ────────────────────────────────────────
# `--registry 127.0.0.1:<port>` or `--registry [::1]:<port>` publishes to a
# local registry instead (scripts/dev-registry/registry.py, a registry:2
# container): every oras call targets that host with `--plain-http`, the
# manifest's `ghcr.io/` prefix being replaced by the loopback host — the same
# host-only mapping the app's debug registry seam applies
# (`TXR_METHOD_ENV_REGISTRY`). No `oras login`, no credentials are read and
# nothing is signed (signing a loopback artifact proves nothing). Only those
# two literal hosts are accepted — not even `localhost`, which a hosts file can
# point anywhere. Without `--registry`, the release path below is unchanged.
#
# ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────────
#   * It does not BUILD. The build is ITEM-2's generator (bases included:
#     `--stage-bases`); this script consumes the staged artifact and verifies
#     it (PLAN note r).
#   * It does not run the method or mount the artifact (ITEM-7's equivalence
#     test is the behavioral arbiter; the hook above calls its verifier).
#   * It does not touch the methods repository (read-only build input) and
#     does not edit the manifest (a new version's artifact is a regeneration +
#     a new manifest commit, never a push-time patch — INV-5).
#   * It never touches the benchmark base images: a layer's `base_ref`/
#     `base_digest` (and a base's `source_ref`/`source_digest`) record the
#     image the files came from — provenance, not a publish target.
#
# ── WHAT YOU NEED ──────────────────────────────────────────────────────────────
#   * the generator's staged build output (TXR_ENV_BUILD_DIR), oras
#     (>= 1.2, tested against the `manifest push` + `blob push` subcommands),
#     cosign (>= 2.4) unless `--skip-sign` or `--registry`, unsquashfs
#     (squashfs-tools) for a base.
#   * for ghcr.io: a GHCR token with `write:packages` in GHCR_TOKEN, and
#     GHCR_USER. The namespaces are tinnlab/txr-method-env-layers (layers) and
#     tinnlab/txresbench-env (bases) on ghcr.io (DEC-2, owner-confirmed D05,
#     already in scripts/network-allowlist.txt); the manifest's oci_ref is
#     authoritative and is REFUSED if it leaves that namespace — no runtime
#     would ever fetch it.
#   * signing identity per DEC-5 (owner's decided verification policy; see the
#     runbook's "Signing" section). Off CI cosign signs with YOUR identity —
#     the decomposition accepts, or use `--skip-sign` only against a runtime
#     with verification disabled (never for a published result).
#
# ── USAGE ──────────────────────────────────────────────────────────────────────
#   scripts/publish-method-env-images.sh (--env <env_id> | --base <base-py|base-r>)
#                                       [--arch amd64|arm64]
#                                       [--manifest <path>] [--staging-dir <dir>]
#                                       [--methods-dir <dir>]
#                                       [--registry 127.0.0.1:<port>|[::1]:<port>]
#                                       [--dry-run] [--skip-sign]
#
# Exactly one of `--env` / `--base` is REQUIRED (one invocation = one
# artifact; nothing defaults across 95 methods). `--staging-dir` defaults to
# $TXR_ENV_BUILD_DIR.
#
# Exit: 0 published (or dry-run complete); 1 a refusal — artifact bytes
# inconsistent, manifest red or without bases, tag already holds different
# bytes, base not published yet, post-push digest mismatch, behavioral-verify
# failure; 2 usage/tooling — bad flag, unknown (env|base, arch), non-loopback
# --registry, cross-arch build without ALLOW_EMULATED_BUILD=1, missing files or
# tools or login credentials.

set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)

REGISTRY=ghcr.io
OCI_REF_PREFIX="ghcr.io/tinnlab/txr-method-env-layers"
BASE_OCI_REF_PREFIX="ghcr.io/tinnlab/txresbench-env"
# The OCI artifact types (layer: application/vnd.txr.method-env.layer.v1,
# base: application/vnd.txr.method-env.base.v1) are carried inside the staged
# artifact-manifest bytes — the publisher never spells them on a command line;
# they are stated here because they are the byte contract's media types
# (design §6 / §6.3).
ARTIFACT_TYPE=application/vnd.txr.method-env.layer.v1
BASE_ARTIFACT_TYPE=application/vnd.txr.method-env.base.v1
# The OCI empty-JSON config blob the artifact manifest references (the
# image-spec's pinned empty descriptor: `{}`, sha256 44136fa3...). The
# publisher materializes it next to the manifest so `oras blob push` can
# upload it — registries reject a manifest whose referenced config blob is
# absent, and this is exactly what oras's own pack path pushes first.
EMPTY_CONFIG_DIGEST=sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a

ENV_ID=""
BASE_ID=""
ARCH=amd64
MANIFEST="$REPO_ROOT/src-app/server/data/method-env-images.json"
STAGING="${TXR_ENV_BUILD_DIR:-}"
METHODS_DIR="${TXR_METHODS_DIR:-}"
DRY_RUN=0
SKIP_SIGN=0
LOOPBACK=""
VERIFY_LIB="$REPO_ROOT/scripts/lib/method-env-verify.sh"

usage() {
  awk 'NR == 1 { next } /^[^#]/ { exit } { sub(/^# ?/, ""); print }' "$0"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_ID=${2-}; shift 2 ;;
    --base) BASE_ID=${2-}; shift 2 ;;
    --arch) ARCH=${2-}; shift 2 ;;
    --manifest) MANIFEST=${2-}; shift 2 ;;
    --staging-dir) STAGING=${2-}; shift 2 ;;
    --methods-dir) METHODS_DIR=${2-}; shift 2 ;;
    --registry) LOOPBACK=${2-}; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-sign) SKIP_SIGN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -n "$ENV_ID" ] && [ -n "$BASE_ID" ]; then
  echo "publish: --env and --base are exclusive (one artifact per invocation)" >&2; exit 2
fi
if [ -z "$ENV_ID" ] && [ -z "$BASE_ID" ]; then
  echo "publish: --env <env_id> or --base <base-py|base-r> is required (one artifact per invocation)" >&2; exit 2
fi
case "$BASE_ID" in
  ""|base-py|base-r) ;;
  *) echo "publish: unknown --base $BASE_ID (expected base-py or base-r)" >&2; exit 2 ;;
esac
case "$ARCH" in
  amd64|arm64) ;;
  *) echo "publish: unsupported --arch: $ARCH (expected amd64 or arm64)" >&2; exit 2 ;;
esac

# ── the loopback rehearsal target (never another host) ────────────────────────
# Exactly `127.0.0.1:<port>` or `[::1]:<port>`, port 1-65535, nothing after it.
if [ -n "$LOOPBACK" ]; then
  if ! printf '%s' "$LOOPBACK" | grep -Eq '^(127\.0\.0\.1|\[::1\]):[0-9]{1,5}$'; then
    echo "publish: --registry must be 127.0.0.1:<port> or [::1]:<port> (a loopback rehearsal" >&2
    echo "registry); got '$LOOPBACK'. Publishing anywhere else is the ghcr.io release path." >&2
    exit 2
  fi
  port=${LOOPBACK##*:}
  port=$((10#$port))
  if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    echo "publish: --registry port $port is outside 1-65535" >&2; exit 2
  fi
fi

# A manifest ref (ghcr.io/…) as the publish target: unchanged for ghcr.io, the
# loopback host in its place for a rehearsal.
target_ref() {
  if [ -n "$LOOPBACK" ]; then
    printf '%s/%s' "$LOOPBACK" "${1#ghcr.io/}"
  else
    printf '%s' "$1"
  fi
}
# oras with the transport flag of the target (plain HTTP on loopback only).
oras_flags=()
[ -z "$LOOPBACK" ] || oras_flags=(--plain-http)
oras_cmd() {
  local sub=$1; shift
  if [ "$sub" = "blob" ] || [ "$sub" = "manifest" ]; then
    local sub2=$1; shift
    oras "$sub" "$sub2" ${oras_flags[@]+"${oras_flags[@]}"} "$@"
  else
    oras "$sub" ${oras_flags[@]+"${oras_flags[@]}"} "$@"
  fi
}
show_oras() {
  local sub=$1; shift
  if [ "$sub" = "blob" ] || [ "$sub" = "manifest" ]; then
    local sub2=$1; shift
    echo "+ oras $sub $sub2 ${oras_flags[*]+${oras_flags[*]} }$*"
  else
    echo "+ oras $sub ${oras_flags[*]+${oras_flags[*]} }$*"
  fi
}

# ── refuse a cross-arch publish (mirror of the framework's sequence) ───────────
# `--arch` DECIDES THE TAG, so it must decide what could have been built; a
# qemu-built artifact (native libs under emulation) is not something to publish
# under a native arch tag that a clinician's mac/linux then fetches. Demand a
# native host, or ALLOW_EMULATED_BUILD=1 + full intent.
HOST_ARCH=$(uname -m)
case "$HOST_ARCH" in
  x86_64|amd64) HOST_DOCKER_ARCH=amd64 ;;
  aarch64|arm64) HOST_DOCKER_ARCH=arm64 ;;
  *) HOST_DOCKER_ARCH=unknown ;;
esac
if [ "$ARCH" != "$HOST_DOCKER_ARCH" ] && [ "${ALLOW_EMULATED_BUILD:-0}" != "1" ]; then
  echo "refusing to publish a $ARCH artifact from a $HOST_DOCKER_ARCH host." >&2
  echo "Build it natively for $ARCH (what the generator's own cross-arch" >&2
  echo "refusal demands, ITEM-2), or set ALLOW_EMULATED_BUILD=1 if you have qemu" >&2
  echo "configured and mean it." >&2
  exit 2
fi

# ── 1. read the committed contract ─────────────────────────────────────────────
# The manifest is authoritative: refs, tags, digests, pins and sizes all come
# from it, never from the operator's flags or the record (the record is
# re-verified against it below; the manifest is the runtime's contract).
if [ ! -f "$MANIFEST" ]; then
  echo "publish: no manifest at $MANIFEST" >&2; exit 2
fi
entry=$(python3 - "$MANIFEST" "$ENV_ID" "$BASE_ID" "$ARCH" <<'PYEOF'
import json, sys
manifest_path, env_id, base_id, arch = sys.argv[1:5]
try:
    with open(manifest_path, "rb") as f:
        m = json.load(f)
except Exception as e:
    print(f"publish: {manifest_path} is not valid JSON: {e}", file=sys.stderr)
    sys.exit(2)
bases = m.get("bases")
BASE_FIELDS = ("base_id", "arch", "oci_ref", "tag", "digest", "squashfs_sha256",
               "size_bytes", "source_ref", "source_digest", "contract")

def no_bases():
    print(f"refusing: {manifest_path} has no bases list — it predates the base publisher, so "
          "its layers have no published base and could never run. Regenerate the manifest "
          "with the current generator (scripts/generate-method-env-images.py) and publish "
          "from that.", file=sys.stderr)
    sys.exit(1)

def base_record(bid):
    for b in bases or []:
        if (b.get("base_id"), b.get("arch")) == (bid, arch):
            return b
    return None

if base_id:
    if bases is None:
        no_bases()
    b = base_record(base_id)
    if b is None:
        print(f"publish: no bases record for {base_id}-{arch}; available: "
              + (", ".join(f"{x.get('base_id')}-{x.get('arch')}" for x in bases) or "(none)"),
              file=sys.stderr)
        sys.exit(2)
    row = ["base"] + [b.get(f, "") for f in BASE_FIELDS] + [m.get("source_revision", "")]
    print("\t".join(str(v) for v in row))
    sys.exit(0)

for e in m.get("envs", []):
    if (e.get("env_id"), e.get("arch")) == (env_id, arch):
        if bases is None:
            no_bases()
        family = {"R": "base-r", "Python": "base-py"}.get(e.get("language"), "")
        b = base_record(family)
        if b is None:
            print(f"refusing: the manifest has no {family}-{arch} base for {env_id}-{arch} "
                  "(the guard refuses that manifest too)", file=sys.stderr)
            sys.exit(1)
        row = ["layer"] + [e.get(f, "") for f in (
            "env_id", "method_id", "method_version", "language", "arch",
            "oci_ref", "tag", "digest", "layer_sha256", "size_bytes",
            "base_ref", "base_digest", "contract", "layer_schema")]
        row.append(m.get("source_revision", ""))
        row += [b.get("base_id", ""), b.get("oci_ref", ""), b.get("tag", ""), b.get("digest", "")]
        print("\t".join(str(v) for v in row))
        sys.exit(0)
print(f"publish: no manifest entry for {env_id}-{arch}; available: "
      + ", ".join(f"{e.get('env_id')}-{e.get('arch')}" for e in m.get("envs", []))
      or "(none — the manifest has no entries yet)", file=sys.stderr)
sys.exit(2)
PYEOF
) || exit $?

if [ -n "$BASE_ID" ]; then
  IFS=$'\t' read -r _KIND B_BASE_ID B_ARCH B_OCI_REF B_TAG B_DIGEST B_SQUASHFS_SHA256 \
    B_SIZE_BYTES B_SOURCE_REF B_SOURCE_DIGEST B_CONTRACT ENTRY_SOURCE_REVISION <<< "$entry"
  if [ "$B_OCI_REF" != "$BASE_OCI_REF_PREFIX/$B_BASE_ID" ]; then
    echo "refusing: base oci_ref $B_OCI_REF is not $BASE_OCI_REF_PREFIX/<base_id>" >&2
    echo "The runtime fetches exactly this ref (the sandbox's base namespace); publishing" >&2
    echo "anywhere else would be unfetchable by the app." >&2
    exit 1
  fi
  KIND_LABEL="base"
  ART_OCI_REF=$B_OCI_REF
  ART_TAG=$B_TAG
  ART_DIGEST=$B_DIGEST
  ART_SHA256=$B_SQUASHFS_SHA256
  ART_SIZE=$B_SIZE_BYTES
  echo "base      : $B_BASE_ID ($B_ARCH, contract $B_CONTRACT)"
  echo "artifact  : $B_OCI_REF:$B_TAG"
  echo "digest    : $B_DIGEST   (bases record — the runtime's fetch unit)"
  echo "file      : base.squashfs sha256 $B_SQUASHFS_SHA256, $B_SIZE_BYTES bytes"
  echo "source    : $B_SOURCE_REF @ $B_SOURCE_DIGEST   (the image it was packed from)"
else
  IFS=$'\t' read -r _KIND ENTRY_ENV_ID ENTRY_METHOD_ID ENTRY_METHOD_VERSION ENTRY_LANGUAGE \
    ENTRY_ARCH ENTRY_OCI_REF ENTRY_TAG ENTRY_DIGEST ENTRY_LAYER_SHA256 ENTRY_SIZE_BYTES \
    ENTRY_BASE_REF ENTRY_BASE_DIGEST ENTRY_CONTRACT ENTRY_LAYER_SCHEMA ENTRY_SOURCE_REVISION \
    PAIR_BASE_ID PAIR_BASE_OCI_REF PAIR_BASE_TAG PAIR_BASE_DIGEST <<< "$entry"
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
  KIND_LABEL="layer"
  ART_OCI_REF=$ENTRY_OCI_REF
  ART_TAG=$ENTRY_TAG
  ART_DIGEST=$ENTRY_DIGEST
  ART_SHA256=$ENTRY_LAYER_SHA256
  ART_SIZE=$ENTRY_SIZE_BYTES
  echo "env       : $ENTRY_ENV_ID"
  echo "method    : $ENTRY_METHOD_ID $ENTRY_METHOD_VERSION ($ENTRY_LANGUAGE)"
  echo "artifact  : $ENTRY_OCI_REF:$ENTRY_TAG"
  echo "digest    : $ENTRY_DIGEST   (manifest entry — the runtime's fetch unit)"
  echo "layer     : sha256 $ENTRY_LAYER_SHA256, $ENTRY_SIZE_BYTES bytes, schema $ENTRY_LAYER_SCHEMA"
  echo "base      : $ENTRY_BASE_REF @ $ENTRY_BASE_DIGEST   (provenance, DEC-4)"
  echo "stacks on : $PAIR_BASE_OCI_REF:$PAIR_BASE_TAG @ $PAIR_BASE_DIGEST   (published first)"
  echo "revision  : $ENTRY_SOURCE_REVISION   (methods repo — the layer's source)"
fi
if [ -n "$LOOPBACK" ]; then
  echo "target    : $LOOPBACK   (loopback rehearsal: plain HTTP, no login, no signing)"
fi

# ── 2. locate the staged artifact ──────────────────────────────────────────────
if [ -z "$STAGING" ]; then
  echo "publish: no staging dir. Build first (scripts/generate-method-env-images.py" >&2
  echo "--manifest <path>) or pass --staging-dir / TXR_ENV_BUILD_DIR (the build" >&2
  echo "output, not a repo directory)." >&2
  exit 2
fi
if [ -n "$BASE_ID" ]; then
  ART_DIR="$STAGING/bases/$B_BASE_ID-$B_ARCH"
  ART_FILE_NAME=base.squashfs
else
  ART_DIR="$STAGING/layers/$ENTRY_ENV_ID-$ENTRY_ARCH"
  ART_FILE_NAME=layer.squashfs
fi
SQUASHFS="$ART_DIR/$ART_FILE_NAME"
RECORD="$ART_DIR/artifact.json"
OCI_MANIFEST="$ART_DIR/oci-manifest.json"
for f in "$SQUASHFS" "$RECORD" "$OCI_MANIFEST"; do
  [ -f "$f" ] || { echo "publish: staging artifact missing $f (rebuild/restage it)" >&2; exit 2; }
done
[ -s "$SQUASHFS" ] || { echo "publish: $SQUASHFS is empty" >&2; exit 2; }

# ── 3. the bytes are the manifest's bytes (INV-4: offline-verifiable, then used)
# Every refusal below names the file and the expected value; nothing is
# normalized. The artifact the runtime will fetch is these exact bytes, and the
# manifest records THEM — a mismatch means a divergent artifact, full stop.
if [ -n "$BASE_ID" ]; then PIN_NAME=squashfs_sha256; else PIN_NAME=layer_sha256; fi
actual_sha=$(sha256sum "$SQUASHFS" | awk '{print $1}')
actual_size=$(wc -c < "$SQUASHFS" | tr -d ' ')
if [ "$actual_sha" != "$ART_SHA256" ]; then
  echo "refusing: $ART_FILE_NAME sha256 $actual_sha != manifest $PIN_NAME $ART_SHA256" >&2
  echo "The staged bytes differ from what the contract declares (INV-4); rebuild at" >&2
  echo "the recorded revision and regenerate the manifest — never hand-edit either." >&2
  exit 1
fi
if [ "$actual_size" != "$ART_SIZE" ]; then
  echo "refusing: $ART_FILE_NAME is $actual_size bytes, manifest size_bytes is $ART_SIZE" >&2
  exit 1
fi
actual_digest="sha256:$(sha256sum "$OCI_MANIFEST" | awk '{print $1}')"
if [ "$actual_digest" != "$ART_DIGEST" ]; then
  echo "refusing: staged oci-manifest.json digest $actual_digest != manifest digest $ART_DIGEST" >&2
  echo "The artifact-manifest bytes the manifest pins are not what is staged" >&2
  echo "(design §6.1/§6.3); regenerate the manifest from this staging dir — the writer" >&2
  echo "stages the exact bytes it pins, so a rebuild is the only repair." >&2
  exit 1
fi
rec_ok=1
if [ -n "$BASE_ID" ]; then
  record=$(python3 - "$RECORD" <<'PYEOF'
import json, sys
try:
    with open(sys.argv[1], "rb") as f:
        r = json.load(f)
except Exception as e:
    print(f"publish: {sys.argv[1]} is not valid JSON: {e}", file=sys.stderr)
    sys.exit(2)
print("\t".join(str(r.get(f, "")) for f in (
    "kind", "base_id", "arch", "oci_ref", "tag", "squashfs_sha256", "size_bytes",
    "source_ref", "source_digest", "contract", "base_file")))
PYEOF
  ) || exit $?
  IFS=$'\t' read -r REC_KIND REC_BASE_ID REC_ARCH REC_OCI_REF REC_TAG REC_SHA256 REC_SIZE_BYTES \
    REC_SOURCE_REF REC_SOURCE_DIGEST REC_CONTRACT REC_BASE_FILE <<< "$record"
  [ "$REC_KIND" = "base" ] || { echo "refusing: record kind $REC_KIND != base" >&2; rec_ok=0; }
  [ "$REC_BASE_ID" = "$B_BASE_ID" ] || { echo "refusing: record base_id $REC_BASE_ID != manifest $B_BASE_ID" >&2; rec_ok=0; }
  [ "$REC_ARCH" = "$B_ARCH" ] || { echo "refusing: record arch $REC_ARCH != manifest $B_ARCH" >&2; rec_ok=0; }
  [ "$REC_OCI_REF" = "$B_OCI_REF" ] || { echo "refusing: record oci_ref $REC_OCI_REF != manifest $B_OCI_REF" >&2; rec_ok=0; }
  [ "$REC_TAG" = "$B_TAG" ] || { echo "refusing: record tag $REC_TAG != manifest $B_TAG" >&2; rec_ok=0; }
  [ "$REC_SHA256" = "$B_SQUASHFS_SHA256" ] || { echo "refusing: record squashfs_sha256 $REC_SHA256 != manifest $B_SQUASHFS_SHA256" >&2; rec_ok=0; }
  [ "$REC_SIZE_BYTES" = "$B_SIZE_BYTES" ] || { echo "refusing: record size_bytes $REC_SIZE_BYTES != manifest $B_SIZE_BYTES" >&2; rec_ok=0; }
  [ "$REC_SOURCE_REF" = "$B_SOURCE_REF" ] || { echo "refusing: record source_ref $REC_SOURCE_REF != manifest $B_SOURCE_REF" >&2; rec_ok=0; }
  [ "$REC_SOURCE_DIGEST" = "$B_SOURCE_DIGEST" ] || { echo "refusing: record source_digest $REC_SOURCE_DIGEST != manifest $B_SOURCE_DIGEST" >&2; rec_ok=0; }
  [ "$REC_CONTRACT" = "$B_CONTRACT" ] || { echo "refusing: record contract $REC_CONTRACT != manifest $B_CONTRACT" >&2; rec_ok=0; }
  [ "$REC_BASE_FILE" = "base.squashfs" ] || { echo "refusing: record base_file $REC_BASE_FILE != base.squashfs" >&2; rec_ok=0; }
else
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
fi
[ "$rec_ok" = "1" ] || { echo "refusing: the build record disagrees with the manifest —" >&2; echo "rebuild/regenerate (one revision, one manifest); never reconcile by hand." >&2; exit 1; }

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

# ── 4b. the behavioral check ───────────────────────────────────────────────────
if [ -n "$BASE_ID" ]; then
  # A base: the staged squashfs must list what the stacked run needs (the layer
  # mount point, prlimit, bash — the generator checked the rootfs before
  # packing; this checks the bytes about to be published). Local, so it runs in
  # --dry-run too.
  command -v unsquashfs >/dev/null 2>&1 || { echo "publish: unsquashfs not found (squashfs-tools; needed to check a base)" >&2; exit 2; }
  echo "+ unsquashfs -lln $SQUASHFS   # /opt/txr-layer, /usr/bin/prlimit, /usr/bin/bash"
  python3 - "$SQUASHFS" "$B_BASE_ID" <<'PYEOF' || { echo "refusing: $B_BASE_ID-$B_ARCH lacks what the stacked run needs (above)." >&2; exit 1; }
import subprocess, sys
path, base_id = sys.argv[1], sys.argv[2]
p = subprocess.run(["unsquashfs", "-lln", path], capture_output=True, text=True)
if p.returncode != 0:
    print(f"publish: unsquashfs cannot list {path}: {p.stderr[-500:]}", file=sys.stderr)
    sys.exit(1)
nodes = {}
for line in p.stdout.splitlines():
    if "squashfs-root" not in line or not line[:1]:
        continue
    kind = line[0]
    rest = line.split("squashfs-root", 1)[1]
    target = None
    if kind == "l" and " -> " in rest:
        rest, target = rest.split(" -> ", 1)
    nodes[rest.strip("/")] = (kind, target)

def resolve(rel):
    parts, done, hops = [c for c in rel.split("/") if c], [], 0
    while parts:
        comp = parts.pop(0)
        if comp == ".":
            continue
        if comp == "..":
            if done:
                done.pop()
            continue
        here = "/".join(done + [comp])
        node = nodes.get(here)
        if node is None:
            return None
        if node[0] == "l":
            hops += 1
            if hops > 40:
                return None
            if node[1].startswith("/"):
                done = []
            parts = [c for c in node[1].split("/") if c] + parts
            continue
        done.append(comp)
    return nodes.get("/".join(done))

need = [("opt/txr-layer", "d"), ("usr/bin/prlimit", "-"), ("usr/bin/bash", "-")]
if base_id == "base-r":
    need.insert(1, ("opt/txr-layer/R-library", "d"))
missing = []
for rel, kind in need:
    node = resolve(rel)
    if node is None or node[0] != kind:
        missing.append("/" + rel)
if missing:
    print(f"refusing: {path} has no " + ", ".join(missing), file=sys.stderr)
    sys.exit(1)
print("verify    : base content OK (" + ", ".join("/" + r for r, _ in need) + ")")
PYEOF
else
  # A layer: ITEM-7's scripts/lib/method-env-verify.sh. Contract: the library
  # defines `txr_method_env_verify_layer LAYER_DIR RECORD_FILE`; non-zero exit
  # refuses the publish (TEST-8). Until the library ships, this prints an honest
  # skip-with-reason — checks 1-3 above are the byte contract, the behavioral
  # equivalence is ITEM-7's arbiter (EX-7).
  if [ -f "$VERIFY_LIB" ]; then
    # shellcheck source=lib/method-env-verify.sh
    . "$VERIFY_LIB"
    if [ "$DRY_RUN" = "1" ]; then
      echo "+ txr_method_env_verify_layer $ART_DIR $RECORD   # behavioral verify"
    else
      if ! txr_method_env_verify_layer "$ART_DIR" "$RECORD"; then
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
fi

# ── 5. login (ghcr.io only) ────────────────────────────────────────────────────
if [ -n "$LOOPBACK" ]; then
  echo "login     : none (loopback rehearsal; no credentials are read)"
  if [ "$DRY_RUN" != "1" ]; then
    command -v oras >/dev/null 2>&1 || { echo "publish: oras not found (need >= 1.2 for manifest push)" >&2; exit 2; }
  fi
elif [ "$DRY_RUN" = "1" ]; then
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

PUSH_REF=$(target_ref "$ART_OCI_REF")

# ── 6. the overwrite refusal (immutable tags) ──────────────────────────────────
# If the tag already exists, it must name the SAME bytes — the same artifact is
# byte-identical (INV-4), so an existing identical digest is a no-op publish;
# anything else means a previous artifact under this tag, which must not be
# shadowed silently. `resolve` failing here is treated as "tag absent" — the
# post-push verify below is the authoritative witness after a successful push.
if [ "$DRY_RUN" = "1" ]; then
  show_oras resolve "$PUSH_REF:$ART_TAG" "  # refuse on mismatch with $ART_DIGEST"
else
  remote=$(oras_cmd resolve "$PUSH_REF:$ART_TAG" 2>/dev/null || true)
  if [ -n "$remote" ]; then
    if [ "$remote" != "$ART_DIGEST" ]; then
      echo "refusing: the tag $ART_TAG already exists at $remote, not the built $ART_DIGEST." >&2
      echo "Tags are immutable; a republish under the same tag means different bytes under" >&2
      echo "a digest the runtime may already have fetched. Publish a new $KIND_LABEL (new tag)" >&2
      echo "or deliberately delete the tag first." >&2
      exit 1
    fi
    echo "tag       : $ART_TAG already names $ART_DIGEST (identical bytes — re-publishing)"
  fi
fi

# ── 6b. a layer's base is published first ──────────────────────────────────────
if [ -z "$BASE_ID" ]; then
  BASE_REF=$(target_ref "$PAIR_BASE_OCI_REF")
  if [ "$DRY_RUN" = "1" ]; then
    show_oras resolve "$BASE_REF:$PAIR_BASE_TAG" "  # must equal $PAIR_BASE_DIGEST (base first)"
  else
    base_remote=$(oras_cmd resolve "$BASE_REF:$PAIR_BASE_TAG" 2>/dev/null || true)
    if [ "$base_remote" != "$PAIR_BASE_DIGEST" ]; then
      echo "refusing: the base $BASE_REF:$PAIR_BASE_TAG resolves to '${base_remote:-nothing}', not $PAIR_BASE_DIGEST." >&2
      echo "A layer is published after its base: publish the base first" >&2
      echo "(--base $PAIR_BASE_ID --arch $ARCH), then this layer." >&2
      exit 1
    fi
    echo "base      : $BASE_REF:$PAIR_BASE_TAG is published ($PAIR_BASE_DIGEST)"
  fi
fi

# ── 7. push the staged bytes verbatim ──────────────────────────────────────────
# blob(s) first — a registry refuses a manifest whose referenced blobs are
# absent — then the manifest bytes themselves, tagged. The squashfs blob is
# pushed from INSIDE its dir so oras records the unstripped relative basename
# in the file store (the construction's title annotation);
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
  show_oras blob push "$PUSH_REF" "$ART_DIR/$ART_FILE_NAME"
  show_oras blob push "$PUSH_REF" "$EMPTY_CONFIG"
  show_oras manifest push "$PUSH_REF:$ART_TAG" "$OCI_MANIFEST"
else
  ( cd "$ART_DIR" && oras_cmd blob push "$PUSH_REF" "$ART_FILE_NAME" )
  oras_cmd blob push "$PUSH_REF" "$EMPTY_CONFIG"
  oras_cmd manifest push "$PUSH_REF:$ART_TAG" "$OCI_MANIFEST"
fi

# ── 8. the registry-visible witness ────────────────────────────────────────────
if [ "$DRY_RUN" = "1" ]; then
  show_oras resolve "$PUSH_REF:$ART_TAG" "  # must equal $ART_DIGEST"
else
  pushed=$(oras_cmd resolve "$PUSH_REF:$ART_TAG")
  if [ "$pushed" != "$ART_DIGEST" ]; then
    echo "refusing: post-push resolve $pushed != recorded $ART_DIGEST." >&2
    echo "The registry now holds a manifest for this tag whose digest does not match the" >&2
    echo "manifest contract (design §6.1/§6.3 — the pinned-construction check). Delete the" >&2
    echo "tag, repair the construction (never by hand-edit) and regenerate + republish." >&2
    exit 1
  fi
  echo "published : $PUSH_REF:$ART_TAG @ $pushed"
fi

# ── 9. sign (provenance floor; the manifest sha256 is the verification floor) ──
if [ -n "$LOOPBACK" ]; then
  echo "!! SIGNING SKIPPED: loopback rehearsal (a loopback artifact is never a published result)."
elif [ "$SKIP_SIGN" = "1" ]; then
  echo "!! SIGNING SKIPPED. A runtime whose verification policy is enabled will REFUSE"
  echo "!! to mount this $KIND_LABEL. Use --skip-sign only against a deployment with"
  echo "!! verification disabled, and never for an artifact a published result depends on."
else
  if [ "$DRY_RUN" = "1" ]; then
    echo "+ cosign sign --yes $ART_OCI_REF@$ART_DIGEST"
  else
    echo "NOTE: off CI, cosign signs with YOUR identity, not a CI OIDC identity."
    echo "See the runbook's signing section before relying on this in production"
    echo "(DEC-5: the app's verification policy decides what is accepted)."
    cosign sign --yes "$ART_OCI_REF@$ART_DIGEST"
  fi
fi

echo "done. The next app build embeds the regenerated manifest; the runtime fetches"
echo "$ART_OCI_REF:$ART_TAG and verifies $ART_SHA256 before mounting."
