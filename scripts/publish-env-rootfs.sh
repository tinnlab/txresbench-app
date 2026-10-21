#!/usr/bin/env sh
# Build and publish an analysis env rootfs to GHCR — the MANUAL path (#80 / DEC-7).
#
# ── WHY THIS SCRIPT EXISTS ───────────────────────────────────────────────────────────
# `.github/workflows/env-images.yml` does exactly this on CI. It is currently
# `.disabled`, and NOT because it is broken: commit 3f6452b8 renamed every workflow in
# the repository to `*.yml.disabled` because the organization's Actions billing is off,
# so a live workflow accrues failed and queued runs and publishes nothing. Renaming it
# back would restore the failures, not the publishes.
#
# Meanwhile the runtime lazy-fetches the MOVING tag `schema<N>-latest-<arch>`, which
# means a recipe change — a new library an analysis needs, a moved pin — is invisible to
# every deployment until an image is published under that tag. Without a manual path, an
# analysis that needs a new library is unschedulable work.
#
# So this script performs the workflow's publish sequence by hand, and a test
# (`server/tests/sandbox/env_publish_runbook_test.rs`) pins the two together so the
# manual path cannot drift from the CI one. When billing is restored, re-enabling is a
# pure `git mv env-images.yml.disabled env-images.yml` and this script becomes the
# break-glass path rather than the primary one.
#
# ── WHAT IT DOES (identical to the workflow's `build` job) ───────────────────────────
#   1. docker build the recipe, passing ROOTFS_SCHEMA_VERSION read from version.rs
#   2. docker create + docker cp the packed squashfs out of the image
#   3. oras push it as an OCI artifact under the IMMUTABLE tag schema<N>-<sha>-<arch>
#   4. oras tag that digest as the MOVING tag schema<N>-latest-<arch> (what the runtime
#      resolves)
#   5. cosign sign the digest (the runtime verifies the signature before mounting)
#
# ── WHAT YOU NEED ────────────────────────────────────────────────────────────────────
#   * docker, oras (>= 1.2), cosign (>= 2.4)
#   * a GHCR token with `write:packages`, exported as GHCR_TOKEN, and GHCR_USER
#   * for step 5, an identity cosign can sign with. Keyless signing on CI uses the
#     workflow's OIDC identity; off CI you must either sign interactively (cosign opens
#     a browser) or supply a key. The runtime verifier accepts the CI identity, so a
#     manually-signed image needs the deployment's verification policy widened to accept
#     yours — see the runbook's "Signing off CI" section. This is the one step that is
#     genuinely NOT equivalent to the CI path, and the script says so rather than
#     pretending otherwise.
#
# ── USAGE ────────────────────────────────────────────────────────────────────────────
#   scripts/publish-env-rootfs.sh [--env <env-id>] [--arch amd64|arm64] [--dry-run]
#                                 [--skip-sign]
#
# --env is optional ONLY while exactly one recipe exists on disk; with more than one it is
# required, because the moving tag this re-points is what running deployments resolve and
# guessing which environment to publish is not a recoverable mistake.
#
# POSIX sh (no bashisms) to match the other scripts in this directory.

set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
ENV_ROOT="$REPO_ROOT/src-app/env-rootfs"
# DERIVED, never spelled. This script is build-tier and must be reusable by a domain that
# ships neither this repository's datatypes nor its environment, so it may not carry a
# default env id — that would make one contributed domain the built-in one. It resolves the
# id from the recipe tree: the sole recipe on disk when there is exactly one, and otherwise
# an explicit `--env`, refused rather than guessed.
#
# This also stops being merely principled the moment a SECOND env image lands: a hard-coded
# default would then publish the wrong one under a moving tag a deployment resolves, which
# is the failure this whole script exists to make safe.
#
# ── IT DELIBERATELY DOES NOT READ `env-rootfs/DEFAULT_ENV` ───────────────────────────
# That file declares which recipe THE BUILD stages (`rootfs::version::select_env_recipe`,
# via `build_helper/sandbox_rootfs.rs`), and this script is not a build. The two questions
# differ in blast radius: a build picks what to stage into a binary you are about to run;
# a publish RE-POINTS the moving `schema<N>-latest-<arch>` tag every running deployment
# resolves. Honouring a declared default here would make "I edited the R recipe" publish
# the python image — which is precisely the defect `.github/workflows/env-images.yml`
# carried until its ENV_ID became a matrix. So with two or more recipes this refuses and
# names them. An earlier version of this comment claimed the resolution mirrored
# `default_env_id`; it does not, and should not.
ENV_ID=""
ARCH=amd64
DRY_RUN=0
SKIP_SIGN=0
REGISTRY=ghcr.io
REPO_PREFIX=cyto-env
ARTIFACT_TYPE=application/vnd.cyto.env-rootfs.squashfs.v1

while [ $# -gt 0 ]; do
    case "$1" in
        --env) ENV_ID=$2; shift 2 ;;
        --arch) ARCH=$2; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;;
        --skip-sign) SKIP_SIGN=1; shift ;;
        -h|--help) sed -n '2,45p' "$0"; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

# Discover the recipes on disk: a directory holding a Dockerfile is one env.
AVAILABLE=$(find "$ENV_ROOT" -mindepth 2 -maxdepth 2 -name Dockerfile -exec dirname {} \; \
    2>/dev/null | while read -r d; do basename "$d"; done | sort)
N=$(printf '%s\n' "$AVAILABLE" | grep -c . || true)

if [ -z "$ENV_ID" ]; then
    if [ "$N" -eq 1 ]; then
        ENV_ID=$AVAILABLE
    elif [ "$N" -eq 0 ]; then
        echo "no env recipe found under $ENV_ROOT" >&2; exit 1
    else
        echo "$N env recipes are available; pass --env <id> to choose one:" >&2
        printf '  %s\n' $AVAILABLE >&2
        echo "(refusing to guess — the moving tag this publishes is what deployments resolve)" >&2
        exit 2
    fi
elif ! printf '%s\n' "$AVAILABLE" | grep -qx "$ENV_ID"; then
    echo "no env recipe named '$ENV_ID' under $ENV_ROOT; available:" >&2
    printf '  %s\n' $AVAILABLE >&2
    exit 1
fi

RECIPE="$ENV_ROOT/$ENV_ID/Dockerfile"
[ -f "$RECIPE" ] || { echo "no recipe at $RECIPE" >&2; exit 1; }

# The schema version is read from the SAME line the workflow reads it from, so the two
# can never publish under different tags. `tail -1` skips the `32` in `u32`.
VERSION_RS="$REPO_ROOT/src-app/server/src/modules/rootfs/version.rs"
SCHEMA=$(grep -E 'const ROOTFS_SCHEMA_VERSION' "$VERSION_RS" | grep -oE '[0-9]+' | tail -1)
[ -n "$SCHEMA" ] || { echo "cannot read ROOTFS_SCHEMA_VERSION from $VERSION_RS" >&2; exit 1; }

SHA=$(git -C "$REPO_ROOT" rev-parse HEAD | cut -c1-12)
OWNER=${GHCR_OWNER:-ziee-ai}
REPO="$REGISTRY/$OWNER/$REPO_PREFIX/$ENV_ID"
IMMUTABLE_TAG="schema$SCHEMA-$SHA-$ARCH"
MOVING_TAG="schema$SCHEMA-latest-$ARCH"
SQUASHFS="$REPO_ROOT/tmp-$ENV_ID-$ARCH.squashfs"

echo "env       : $ENV_ID"
echo "arch      : $ARCH   (built natively; see the --arch note below)"
echo "schema    : $SCHEMA   (NOT bumped for a package addition — see rootfs/version.rs)"
echo "repo      : $REPO"
echo "immutable : $IMMUTABLE_TAG"
echo "moving    : $MOVING_TAG   <- the tag the runtime resolves"

run() {
    echo "+ $*"
    [ "$DRY_RUN" = "1" ] || "$@"
}

# ── 1/5 build ────────────────────────────────────────────────────────────────────────
# The build context is the recipe's own directory, so `COPY requirements.txt` resolves.
#
# --arch DECIDES THE TAG, so it must also decide what is built. The CI workflow gets its
# architecture from a NATIVE runner ("no emulation" — see the matrix comment in
# env-images.yml.disabled); run by hand there is no such guarantee, and a script that
# labelled host bytes with another architecture's moving tag would publish an image that
# an arm64 deployment fetches, cosign-verifies and then cannot execute. So: pass
# --platform, and REFUSE a cross-architecture build outright unless the operator has
# opted in to emulation, because a qemu-built scientific stack is not something to publish
# by accident.
case "$ARCH" in
    amd64) PLATFORM=linux/amd64 ;;
    arm64) PLATFORM=linux/arm64 ;;
    *) echo "unsupported --arch: $ARCH (expected amd64 or arm64)" >&2; exit 2 ;;
esac
HOST_ARCH=$(uname -m)
case "$HOST_ARCH" in
    x86_64|amd64) HOST_DOCKER_ARCH=amd64 ;;
    aarch64|arm64) HOST_DOCKER_ARCH=arm64 ;;
    *) HOST_DOCKER_ARCH=unknown ;;
esac
if [ "$ARCH" != "$HOST_DOCKER_ARCH" ] && [ "${ALLOW_EMULATED_BUILD:-0}" != "1" ]; then
    echo "refusing to publish a $ARCH image from a $HOST_DOCKER_ARCH host." >&2
    echo "The tags this script moves are resolved by real deployments; an emulated build" >&2
    echo "is not something to publish unknowingly. Build on a native $ARCH host (what CI" >&2
    echo "does), or set ALLOW_EMULATED_BUILD=1 if you have qemu configured and mean it." >&2
    exit 2
fi
run docker build \
    --platform "$PLATFORM" \
    -f "$RECIPE" \
    --build-arg "ROOTFS_SCHEMA_VERSION=$SCHEMA" \
    -t "rootfs-build:$ARCH" \
    "$ENV_ROOT/$ENV_ID"

# ── 1b/5 BEHAVIOURAL verification of what was just built (#196 R7) ───────────────────
# This is the AUTHORITATIVE holder of "every env image can run jq". It runs the binary
# in the image rather than pattern-matching the recipe source, because the source-text
# form of this check was satisfied by a COMMENT while the binary was absent — proved on
# the shipped recipe, whose three jq-mentioning comments kept `contains(" jq ")` true
# with jq deleted from the apt line. Comments do not install binaries, so every comment
# spelling is covered here by construction. See scripts/lib/env-image-verify.sh.
#
# Placed BEFORE the push deliberately: an image that cannot run jq must not reach the
# registry, where `publish-env-rootfs.sh`'s own header calls the mistake unrecoverable.
# shellcheck source=lib/env-image-verify.sh
. "$(dirname "$0")/lib/env-image-verify.sh"
if [ "$DRY_RUN" != "1" ]; then
    cyto_verify_image_runs_jq "rootfs-build:$ARCH" || exit 1
else
    echo "+ cyto_verify_image_runs_jq rootfs-build:$ARCH"
fi

# ── 2/5 extract the packed squashfs ──────────────────────────────────────────────────
if [ "$DRY_RUN" = "1" ]; then
    echo "+ docker create/cp/rm  ->  $SQUASHFS"
else
    CID=$(docker create "rootfs-build:$ARCH")
    docker cp "$CID:/rootfs.squashfs" "$SQUASHFS"
    docker rm "$CID" >/dev/null
    ls -lh "$SQUASHFS"
fi

# ── 3/5 push under the IMMUTABLE tag ─────────────────────────────────────────────────
# Annotations mirror the workflow's exactly — provenance readers key on them.
if [ "$DRY_RUN" != "1" ]; then
    : "${GHCR_TOKEN:?set GHCR_TOKEN (a token with write:packages)}"
    : "${GHCR_USER:?set GHCR_USER (your GitHub username)}"
    echo "$GHCR_TOKEN" | oras login "$REGISTRY" -u "$GHCR_USER" --password-stdin
fi
run oras push \
    --artifact-type "$ARTIFACT_TYPE" \
    --annotation "org.opencontainers.image.source=https://github.com/$OWNER/cytoanalyst" \
    --annotation "org.opencontainers.image.revision=$(git -C "$REPO_ROOT" rev-parse HEAD)" \
    --annotation "com.cytoanalyst.rootfs.schema=$SCHEMA" \
    --annotation "com.cytoanalyst.env=$ENV_ID" \
    --annotation "com.cytoanalyst.arch=$ARCH" \
    "$REPO:$IMMUTABLE_TAG" \
    "$SQUASHFS:$ARTIFACT_TYPE"

# ── 4/5 re-point the MOVING tag ──────────────────────────────────────────────────────
# This is the step that makes the change VISIBLE to running deployments; everything
# before it publishes bytes nobody resolves.
run oras tag "$REPO:$IMMUTABLE_TAG" "$MOVING_TAG"

# ── 5/5 sign ─────────────────────────────────────────────────────────────────────────
if [ "$SKIP_SIGN" = "1" ]; then
    echo "!! SIGNING SKIPPED. A deployment whose verification policy is enabled will REFUSE"
    echo "!! to mount this image. Only use --skip-sign against a deployment with"
    echo "!! verification disabled, and never for anything a published result depends on."
else
    if [ "$DRY_RUN" = "1" ]; then
        echo "+ cosign sign --yes $REPO@<digest>"
    else
        DIGEST=$(oras resolve "$REPO:$IMMUTABLE_TAG")
        echo "published $REPO@$DIGEST (schema$SCHEMA, $ARCH)"
        echo "NOTE: off CI, cosign signs with YOUR identity, not the workflow's OIDC"
        echo "      identity the runtime verifier expects. See the runbook's"
        echo "      'Signing off CI' section before relying on this in production."
        cosign sign --yes "$REPO@$DIGEST"
    fi
fi

[ "$DRY_RUN" = "1" ] || rm -f "$SQUASHFS"
echo "done. Deployments pick this up on their next fetch of $MOVING_TAG."
