#!/usr/bin/env sh
# build-env-rootfs-local.sh — the LOCAL build + stage loop for an analysis env image.
# E5 / #193, epic #169.
#
# ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────
# `fetch-env-rootfs.sh` gets an env image by PULLING it from GHCR. That is the right
# path for a deployment and the wrong one for a developer changing a recipe, because
# `ghcr.io/ziee-ai/cyto-env/*` is not anonymously pullable, publishing to it needs a
# `write:packages` token, and the workflow that would publish it is parked as
# `.disabled` (commit 3f6452b8, org Actions billing — see `publish-env-rootfs.sh`).
# So a recipe change was, until this script, unobservable without a credential the
# repository does not have.
#
# The owner's ruling is the design source: "we can build it locally and change the
# rootfs repo for testing". This is that loop:
#
#     discover → build → extract → verify → stage → (hand to the seam)
#
# and it stops exactly where `publish-env-rootfs.sh` starts needing a registry. There
# is no `oras`, no `cosign`, no `gh`, no GHCR reference anywhere below this header.
#
# ── WHAT IT IS NOT ──────────────────────────────────────────────────────────────────
# It does NOT publish, and it does not make publishing possible. #80 still gates
# shipping an image to a deployment; this gates nothing but your own box. A locally
# built image is also NOT signed by the CI OIDC identity the runtime's release
# verification policy pins (`DEFAULT_IDENTITY_RE` in
# `src-app/server/src/modules/sandbox/env_image.rs`) — see the runbook's "The local
# build + run loop" section. Seam 1, which this script feeds, has no signature in its
# path at all: the operator vouches for bytes they built themselves. That is a real
# difference from the published path and it is stated here rather than glossed.
#
# ── THE ENV IS DERIVED, NEVER TYPED ─────────────────────────────────────────────────
# A directory under `src-app/env-rootfs/` holding a `Dockerfile` is one env — the same
# discovery `publish-env-rootfs.sh` and the parked workflow's `gate` job use. With more
# than one recipe and no `--env`, this REFUSES and names them, exactly as the publisher
# does; use `--all` to cover every env, which is the local analogue of the workflow's
# matrix. No env id is spelled in this file, and a test enforces that.
#
# ── THE SEAM VARIABLE CANNOT BE `export`ed ──────────────────────────────────────────
# The per-env air-gap seam is `CYTO_ENV_ROOTFS_SQUASHFS__<env-id>`. Every env id this
# tree ships contains `-`, which is NOT legal in a shell identifier, so:
#
#     export CYTO_ENV_ROOTFS_SQUASHFS__my-env=/path   ->  bash: not a valid identifier
#     CYTO_ENV_ROOTFS_SQUASHFS__my-env=/path cmd       ->  sh: ...: not found
#     env 'CYTO_ENV_ROOTFS_SQUASHFS__my-env=/path' cmd ->  works, and is inherited
#
# Only the `env(1)` form works. This script therefore PRINTS a ready-to-run `env` line
# rather than an `export` line a reader would paste and watch fail. `--print-seam`
# emits just that line, for `eval`-free use as a command prefix.
#
# ── USAGE ───────────────────────────────────────────────────────────────────────────
#   scripts/build-env-rootfs-local.sh --env <id>            # build + stage one env
#   scripts/build-env-rootfs-local.sh --all                 # every discovered recipe
#   scripts/build-env-rootfs-local.sh --env <id> --reuse-image <tag>
#                                                           # skip the build, stage an
#                                                           # image already in docker
#   scripts/build-env-rootfs-local.sh --print-seam          # print seam lines for what
#                                                           # is ALREADY staged; no build
#   scripts/build-env-rootfs-local.sh --list                # print discovered env ids
#
# `--all` runs every env INDEPENDENTLY: one env's failure does not abort the others, the
# summary names every failure, and the exit status is non-zero if any env failed.
#
# `--reuse-image` REFUSES any image that is not LABELLED for the env you named — a
# mismatched label and an absent label are both refusals, with no escape hatch. Nothing
# else in this script can tell one env's rootfs from another's (every other check is
# deliberately env-agnostic), so that label is the only substitution guard there is, and
# `--print-seam` additionally re-verifies each staged artifact against the sha256 this
# loop recorded for it before emitting its seam.
#
# On success the LAST line is the staged squashfs path, so a caller can do
#   sq=$(scripts/build-env-rootfs-local.sh --env <id> | tail -1)
#
# POSIX sh (no bashisms) to match the other scripts in this directory.

set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
ENV_ROOT="$REPO_ROOT/src-app/env-rootfs"

ENV_ID=""
# DERIVED from the host, exactly as `fetch-env-rootfs.sh` derives it, and NOT typed.
# It was `amd64`. That is wrong twice over on an arm64 box: the build is refused as
# cross-architecture, and — worse — `--print-seam` and the cache path would be computed
# for amd64, so the loop would report "nothing is staged" over artifacts it had just
# produced. A hard-coded arch is a typed constant in a script whose whole thesis is that
# such things are derived.
case "$(uname -m)" in
    x86_64|amd64)  ARCH=amd64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) ARCH="" ;;
esac
ARCH="${CYTO_ENV_ARCH:-$ARCH}"
ALL=0
LIST=0
PRINT_SEAM=0
REUSE_IMAGE=""

while [ $# -gt 0 ]; do
    case "$1" in
        # Operand checks: without them a missing value hits `set -u` and reports
        # "2: parameter not set" — a shell internal, naming neither the flag nor the
        # script — and `--env --all` silently consumes the next FLAG as the env id.
        --env)   [ $# -ge 2 ] || { echo "build-env-rootfs-local: --env needs an <env-id>" >&2; exit 2; }
                 case "$2" in -*) echo "build-env-rootfs-local: --env got the flag '$2', not an env id" >&2; exit 2 ;; esac
                 ENV_ID=$2; shift 2 ;;
        --arch)  [ $# -ge 2 ] || { echo "build-env-rootfs-local: --arch needs amd64|arm64" >&2; exit 2; }
                 case "$2" in -*) echo "build-env-rootfs-local: --arch got the flag '$2', not an architecture" >&2; exit 2 ;; esac
                 ARCH=$2; shift 2 ;;
        --all) ALL=1; shift ;;
        --list) LIST=1; shift ;;
        --print-seam) PRINT_SEAM=1; shift ;;
        --reuse-image)
                 [ $# -ge 2 ] || { echo "build-env-rootfs-local: --reuse-image needs an image ref" >&2; exit 2; }
                 case "$2" in -*) echo "build-env-rootfs-local: --reuse-image got the flag '$2', not an image ref" >&2; exit 2 ;; esac
                 REUSE_IMAGE=$2; shift 2 ;;
        # The header block, DERIVED: every comment line from line 2 up to the first line
        # that is neither a comment nor blank. A `sed -n '2,50p'` here is a stale doc
        # waiting to happen — `fetch-env-rootfs.sh` outgrew exactly that.
        -h|--help)
            awk 'NR > 1 { if ($0 !~ /^#/ && $0 != "") exit; print }' "$0"; exit 0 ;;
        *) echo "build-env-rootfs-local: unknown argument: $1" >&2; exit 2 ;;
    esac
done

log() { printf '[env-local] %s\n' "$*" >&2; }
die() { printf '[env-local] FAIL: %s\n' "$*" >&2; exit 1; }

# ── discovery: a directory holding a Dockerfile is one env ──────────────────────────
# Same shape as `publish-env-rootfs.sh`'s AVAILABLE and the parked workflow's `gate`
# job. Kept as its own spelling rather than a shared library on purpose: the drift test
# `both_publishers_derive_the_env_set_rather_than_naming_one` reads the publisher's own
# text for `-name Dockerfile`, so hoisting it would delete the literal that test reads
# and turn a correct refactor into a red gate. The two are instead held together
# BEHAVIOURALLY — `check-env-loop.sh` runs both refusals and diffs the
# candidate lists — which is the check that would actually catch a drift, rather than a
# third textual copy that can go stale in step with nothing.
AVAILABLE=$(find "$ENV_ROOT" -mindepth 2 -maxdepth 2 -name Dockerfile -exec dirname {} \; \
    2>/dev/null | while read -r d; do basename "$d"; done | sort)
N=$(printf '%s\n' "$AVAILABLE" | grep -c . || true)
[ "$N" -gt 0 ] || die "no env recipe found under $ENV_ROOT — there is nothing to build,
  and building nothing is not a success."

# Two output modes cannot both own the last line. `--list` silently outranked
# `--print-seam` (both orders), so a caller piping to `tail -1` got a bare env id where it
# expected a seam assignment — the same silent ranking this script refuses for
# `--print-seam --all` and the sibling refuses for `--seams --env`.
[ "$LIST" = "1" ] && [ "$PRINT_SEAM" = "1" ] && die "--list and --print-seam both decide what
  this script prints; pick one."
[ "$LIST" = "1" ] && [ -n "$REUSE_IMAGE" ] && die "--list does not build, so --reuse-image
  has no meaning here."
[ "$PRINT_SEAM" = "1" ] && [ -n "$REUSE_IMAGE" ] && die "--print-seam reports what is already
  staged; it does not build, so --reuse-image has no meaning here."

if [ "$LIST" = "1" ]; then
    # It FILTERS as well as validating. It used to validate `--env` and then print every
    # id anyway, so `--list --env <a> | tail -1` yielded <b> — the substitution shape in
    # miniature, and the identical omission the --print-seam block below already fixed.
    if [ -n "$ENV_ID" ]; then
        printf '%s\n' "$AVAILABLE" | grep -qx "$ENV_ID" || die "no env recipe named '$ENV_ID'; available:
$(printf '  %s\n' $AVAILABLE)"
        printf '%s\n' "$ENV_ID"
        exit 0
    fi
    printf '%s\n' $AVAILABLE
    exit 0
fi

case "$ARCH" in
    amd64) PLATFORM=linux/amd64 ;;
    arm64) PLATFORM=linux/arm64 ;;
    "") die "cannot derive an architecture from \`uname -m\` ($(uname -m)).
  Name one explicitly: --arch amd64|arm64 (or set CYTO_ENV_ARCH)." ;;
    *) die "unsupported architecture: $ARCH (expected amd64 or arm64)" ;;
esac
HOST_ARCH=$(uname -m)
case "$HOST_ARCH" in
    x86_64|amd64) HOST_DOCKER_ARCH=amd64 ;;
    aarch64|arm64) HOST_DOCKER_ARCH=arm64 ;;
    *) HOST_DOCKER_ARCH=unknown ;;
esac

# The schema version is READ from the one source of truth, never typed here — the same
# line `publish-env-rootfs.sh` and `fetch-env-rootfs.sh` read. `tail -1` skips the `32`
# in `u32`.
VERSION_RS="$REPO_ROOT/src-app/server/src/modules/rootfs/version.rs"
SCHEMA=$(grep -E 'const ROOTFS_SCHEMA_VERSION' "$VERSION_RS" | grep -oE '[0-9]+' | tail -1)
[ -n "$SCHEMA" ] || die "cannot read ROOTFS_SCHEMA_VERSION from $VERSION_RS —
  the schema is the contract between the binary and the image; refusing to guess it."

# The SAME cache layout `fetch-env-rootfs.sh` owns, so a locally built artifact and a
# fetched one are interchangeable at the seam and `--print-path` finds either.
CACHE="${CYTO_ENV_ROOTFS_CACHE:-$REPO_ROOT/.cyto-cache/env-rootfs}"
SEAM_KEY=CYTO_ENV_ROOTFS_SQUASHFS
# The docker LABEL every build below stamps with the env id it was built from. It is the
# ONLY artifact-side evidence tying a set of bytes to an env: the schema marker, jq's
# presence and jq's execution are all env-agnostic by construction. `--reuse-image`
# checks it, which is what stops a convenience flag from re-creating the substitution
# defect this whole epic exists to close.
ENV_LABEL=com.cytoanalyst.env

staged_path_for() { echo "$CACHE/$1-schema$SCHEMA-$ARCH.squashfs"; }

# The ONE form that actually works — see the header. Printed, never `export`ed.
seam_line_for() { printf "env '%s__%s=%s'" "$SEAM_KEY" "$1" "$(staged_path_for "$1")"; }

if [ "$PRINT_SEAM" = "1" ]; then
    # RESPECTS --env, and refuses to answer a different question than the one asked.
    # It used to ignore --env entirely and emit lines for every staged env, so
    # `--env <a> --print-seam | tail -1` handed the caller <b>'s artifact — a request for
    # one env answered with another env's, which is the substitution shape in miniature.
    # (The sibling script's --env/--seams exclusion carries the same reasoning: two flags
    # answering the same question must not be silently ranked.)
    [ "$ALL" = "1" ] && die "--print-seam already covers every staged env; --all adds nothing
  and would hide which envs are actually staged. Drop one of them."
    if [ -n "$ENV_ID" ]; then
        printf '%s\n' "$AVAILABLE" | grep -qx "$ENV_ID" || die "no env recipe named '$ENV_ID'."
        SEAM_TARGETS="$ENV_ID"
    else
        SEAM_TARGETS="$AVAILABLE"
    fi
    # BUFFERED. Lines used to go to stdout as each env verified, so with env A honest and
    # env B substituted a caller got A's line and — reading through a pipe, which is how
    # this script's own header says callers use it — lost the failing status: a silently
    # PARTIAL prefix, produced by exactly the corruption this check exists to catch.
    # Nothing is emitted until every requested env has verified.
    seam_buf=""
    found=0
    command -v sha256sum >/dev/null 2>&1 || die "\`sha256sum\` is not on PATH, so a staged
  artifact's identity cannot be checked. Refusing rather than emitting an unverified seam:
  this path requires neither docker nor the mount tools, so it is reachable on a box that
  has no other check available."
    for id in $SEAM_TARGETS; do
        p=$(staged_path_for "$id")
        [ -s "$p" ] || continue
        # ── CONTENT VERIFICATION, and this is the load-bearing part ─────────────
        # The staged squashfs carries NO env marker: the `com.cytoanalyst.env` label
        # lives on the docker IMAGE and does not survive `docker cp`, and every other
        # check this loop runs is env-AGNOSTIC by construction (schema, jq presence, jq
        # execution — chosen precisely because they name no analysis domain). So without
        # this, the only thing binding these bytes to this env is the FILENAME, and a
        # cache slot overwritten by anything — a stray `cp`, an interrupted stage, a
        # tool run by hand — is emitted as that env's seam and then served BY NAME. A
        # blind audit demonstrated exactly that end to end.
        #
        # What CAN be checked without naming a domain is CONTENT IDENTITY: the sha256
        # this loop recorded when it built that env's recipe. Re-hash and compare.
        # Measured cost: ~3 s for both shipped artifacts (~1 GB) — cheap next to being
        # wrong about which interpreter a job runs against.
        side="${p%.squashfs}.sha256"
        if [ ! -s "$side" ]; then
            # A FETCHED artifact is not a broken one. `fetch-env-rootfs.sh` pulls by
            # digest, cosign-verifies and writes `<name>.digest`; it now writes this
            # sidecar too, but an artifact cached BEFORE that change has only the
            # `.digest`. Telling that operator to run a 20-minute docker build for a
            # perfectly good, registry-verified image would be a false remedy, so the
            # message names the cheap one.
            hint_fetch=""
            [ -s "${p%.squashfs}.digest" ] && hint_fetch="
  This artifact came from the registry (a .digest sits beside it) and predates the
  sidecar. Re-fetch to record one — it is a cache hit, not a re-download:
      scripts/fetch-env-rootfs.sh $id"
            die "the artifact staged for '$id' has no recorded sha256 beside it
  ($side), so nothing can say which recipe produced it. Refusing to emit a seam for bytes
  of unknown provenance: the runtime resolves this seam BY NAME.
  Rebuild it: $0 --env $id$hint_fetch"
        fi
        want=$(tr -d ' \t\n' < "$side")
        # The HASHER'S OWN STATUS, not the pipeline's. `sha256sum … | cut` takes `cut`'s
        # status, and cut exits 0 on empty input — so a failing or absent hasher left
        # `got` empty and the code below reported "those bytes are not the ones built
        # from this recipe", a SUBSTITUTION ALARM for an I/O error. Reproduced with a
        # failing shim. Asserting a wrong cause is the false-diagnosis failure this
        # branch has already fixed twice elsewhere.
        if ! got_raw=$(sha256sum "$p"); then
            die "could not hash the artifact staged for '$id' ($p). This says nothing
  about whether those bytes are the right ones — it is an I/O or tooling failure, and it
  is reported as itself rather than as a substitution."
        fi
        got=${got_raw%% *}
        if [ "$want" != "$got" ]; then
            die "the artifact staged for '$id' does NOT match the sha256 this loop
  recorded for it:
      recorded $want
      on disk  $got
  Those bytes are not the ones built from '$id''s recipe. Refusing to emit a seam for
  them: the runtime resolves this seam BY NAME, so a job declaring '$id' would mount
  whatever this is and fail as though the analysis were broken. Rebuild: $0 --env $id"
        fi
        seam_buf="$seam_buf$(seam_line_for "$id")
"
        found=$((found + 1))
    done
    [ "$found" -gt 0 ] || die "--print-seam: nothing is staged${ENV_ID:+ for '$ENV_ID'} under $CACHE.
  Build one first: $0 --env <id>   (or --all)"
    printf '%s' "$seam_buf"
    exit 0
fi

# ── which env(s)? REFUSE rather than guess, exactly as the publisher does ────────────
if [ "$ALL" = "1" ]; then
    [ -z "$ENV_ID" ] || die "--all and --env are mutually exclusive."
    TARGETS="$AVAILABLE"
elif [ -n "$ENV_ID" ]; then
    printf '%s\n' "$AVAILABLE" | grep -qx "$ENV_ID" || {
        echo "[env-local] FAIL: no env recipe named '$ENV_ID' under $ENV_ROOT; available:" >&2
        printf '  %s\n' $AVAILABLE >&2
        exit 1
    }
    TARGETS="$ENV_ID"
elif [ "$N" -eq 1 ]; then
    # Exactly one recipe: using it CHOOSES nothing, so there is no guess to refuse.
    TARGETS="$AVAILABLE"
else
    echo "[env-local] FAIL: $N env recipes are available, so which one to build is a" >&2
    echo "  CHOICE and this script will not make it for you. Name one:" >&2
    printf '%s\n' "$AVAILABLE" | sed "s|^|      $0 --env |" >&2
    echo "  …or build every one of them:" >&2
    echo "      $0 --all" >&2
    exit 2
fi

if [ -n "$REUSE_IMAGE" ]; then
    case "$TARGETS" in
        *" "*|*"
"*) die "--reuse-image names ONE image, so it cannot be combined with a multi-env run." ;;
    esac
fi

command -v docker >/dev/null 2>&1 \
    || die "\`docker\` is not on PATH, and this loop's first leg is a docker build.
  Refusing rather than reporting a success that staged nothing."
docker info >/dev/null 2>&1 \
    || die "the docker daemon is not reachable (\`docker info\` failed).
  Refusing rather than reporting a success that staged nothing."

mkdir -p "$CACHE"

# Wall clock in whole seconds, portable: `date +%s` is POSIX; `%N` is not.
now() { date +%s; }
BOX_LOAD=$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null || echo 'n/a')
# MemAvailable is in kB; report GiB so the number is readable and cannot be mistaken
# for megabytes (a `free -m` column read as MB is how "99 GB free" became "100 MB free"
# in this branch's own brief, which would have descoped a leg that runs fine).
BOX_FREE=$(awk '/MemAvailable/ {printf "%.1f GiB", $2/1048576}' /proc/meminfo 2>/dev/null || echo 'n/a')

# `--all` is the local analogue of the parked workflow's build MATRIX, and a matrix
# reports every leg. The first version accumulated an `overall_rc` it never assigned and
# exited 0 unconditionally, while `set -eu` + `die` actually aborted the whole run on the
# first failing env — so `--all` neither covered every env nor reported which one broke.
# Each env now runs in its own SUBSHELL: a `die` inside it ends that env, not the run.
overall_rc=0
FAILED=""
# `|| true` for the same reason the sibling count at the top of this file has it: `grep -c`
# EXITS 1 on a zero count, so under `set -e` an empty TARGETS would abort here silently,
# with no message at all — defeating the die-with-a-reason discipline the rest of the file
# enforces. Not reachable today (TARGETS derives from a floored AVAILABLE); a latent trap
# is still a trap.
N_TARGETS=$(printf '%s\n' $TARGETS | grep -c . || true)
STAGED_LIST=$(mktemp)
trap 'rm -f "$STAGED_LIST"' EXIT

for id in $TARGETS; do
  # ── WHY `set +e` HERE, AND `set -e` INSIDE ──────────────────────────────────────
  # This was `if ( … ); then :; else …; fi`, which is WRONG in a way that reads as
  # correct: POSIX (and bash, and dash) IGNORE `set -e` inside a command used as an `if`
  # CONDITION, and that suspension propagates INTO the subshell. Measured in all three:
  #   sh -c 'set -eu; if ( false; echo SUPPRESSED; true ); then echo T; fi'  -> SUPPRESSED
  # An explicit `set -e` inside the subshell does NOT re-arm it (also measured). So the
  # unguarded `docker build` below stopped aborting its env — and because the loop
  # deliberately KEEPS the tagged image as a layer cache, a build that failed after an
  # earlier success left the stale image in place, `docker create` succeeded against it,
  # every (env-agnostic) verification leg passed on the OLD bytes, and the script printed
  # STAGED and exited 0. A broken recipe reporting success while staging the previous
  # image is the precise thing this loop exists to make observable.
  #
  # The fix is structural: disarm errexit in the PARENT for the duration, arm it
  # explicitly INSIDE the subshell (which is now a plain command, not a condition), and
  # read the status from `$?`. Verified in sh, bash and dash: a failing body stops at the
  # failure and yields rc=1; a succeeding body yields rc=0.
  set +e
  (
    set -e
    RECIPE="$ENV_ROOT/$id/Dockerfile"
    [ -f "$RECIPE" ] || die "no recipe at $RECIPE"
    OUT=$(staged_path_for "$id")
    # The image tag is BUILT from the derived id, never spelled.
    TAG="cyto-env-local-$id:schema$SCHEMA-$ARCH"

    echo "── $id ────────────────────────────────────────────────" >&2
    log "recipe : $RECIPE"
    log "schema : $SCHEMA   (read from version.rs, not typed)"
    log "arch   : $ARCH"
    log "stage  : $OUT"

    # ── 1/4 build ───────────────────────────────────────────────────────────────
    t_build_start=$(now)
    if [ -n "$REUSE_IMAGE" ]; then
        # LOUD, and it refuses to claim the build leg ran. A default that quietly
        # never builds is how a build loop becomes a staging loop nobody notices.
        log "!! BUILD SKIPPED — reusing the existing image '$REUSE_IMAGE'."
        log "!! This run does NOT prove the recipe builds. The staged artifact's identity"
        log "!! is still the sha256 of the bytes extracted, so it cannot pose as a fresh"
        log "!! build; but if you changed the recipe, drop --reuse-image."
        docker image inspect "$REUSE_IMAGE" >/dev/null 2>&1 \
            || die "--reuse-image '$REUSE_IMAGE' is not present in the local docker image store."

        # ── THE SUBSTITUTION GUARD, and why it is here ──────────────────────────
        # Every verification leg below is deliberately env-AGNOSTIC: the schema marker,
        # jq's presence and jq's execution are satisfied identically by every env image
        # in this tree (that is the point of choosing jq — it names no analysis domain).
        # So without this check the ONLY thing binding these bytes to this env is the
        # filename `--env` computes, and `--reuse-image <other-env-image> --env <this>`
        # would stage the wrong rootfs under this env's key, pass every check, and then
        # be served BY NAME at the seam. That is precisely the failure INV-2 exists to
        # prevent — an analysis running against the wrong interpreter and reporting the
        # result as though the analysis were broken — reintroduced by the loop's own
        # convenience flag. A blind design-conformance audit found it.
        # The read's own status is kept SEPARATE from its output, so "this image carries
        # no such label" and "we could not read the label at all" are distinguishable.
        # Both are refusals now, but they need different messages: one says rebuild, the
        # other says your docker is not answering.
        if ! reused_env="$(docker image inspect --format \
            "{{index .Config.Labels \"$ENV_LABEL\"}}" "$REUSE_IMAGE" 2>/dev/null)"; then
            die "could not read \`$ENV_LABEL\` from '$REUSE_IMAGE' (docker image inspect
  failed). Refusing: with no label READ there is nothing to compare, and every other
  check this loop runs is env-agnostic. This is a TOOLING failure, distinct from an
  absent label — check that the docker daemon is answering, then build it through this
  loop, which is what applies the label."
        fi
        case "$reused_env" in
            "$id") log "reused image is labelled '$id' — it is this env's image" ;;
            "" | "<no value>")
                # NO ESCAPE HATCH. There was one (an env var asserting "trust me, these
                # are that env's bytes"), and it was wrong for a reason worth recording:
                # an acknowledged reuse still WROTE the .sha256 sidecar, so the artifact
                # and its recorded identity agreed perfectly and the INV-2 acceptance
                # test — which compares the runtime digest against that sidecar — passed
                # on substituted bytes. The escape did not merely weaken a check; it
                # manufactured the evidence the check reads. An env var also persists
                # across a shell session, so one legitimate use silently covered every
                # later one.
                #
                # Building costs a `docker build` that the layer cache makes ~1 s for an
                # unchanged recipe, and it produces a LABELLED image. There is no case
                # where asserting the binding is better than establishing it.
                die "--reuse-image '$REUSE_IMAGE' carries no \`$ENV_LABEL\` label, so
  NOTHING here can tell whether those bytes are $id's rootfs or another env's. Every
  other check this loop runs is env-agnostic by design, so staging an unlabelled image
  under $id's key would succeed silently and then be served BY NAME for $id — a job
  would run against the wrong interpreter and fail as though the analysis were broken.

  Build it through this loop instead (drop --reuse-image); the layer cache makes an
  unchanged recipe cheap, and the build is what applies the label." ;;
            *)
                die "--reuse-image '$REUSE_IMAGE' is labelled \`$ENV_LABEL=$reused_env\`,
  but you asked to stage it as '$id'. Refusing to substitute one env's rootfs for
  another: the job would run against the wrong interpreter and libraries, and fail in a
  way that reads as the ANALYSIS being broken rather than as the wrong image." ;;
        esac
        # CROSS-ARCHITECTURE, on the reuse path too. The refusal below used to live only
        # in the build branch, while `staged_path_for` names the file with the HOST arch
        # regardless — so a foreign-arch image could be staged under
        # `<id>-schema<N>-<host-arch>.squashfs`, and only the bwrap leg might catch it
        # (and would not on a box with binfmt/qemu registered).
        reused_arch="$(docker image inspect --format '{{.Architecture}}' "$REUSE_IMAGE" 2>/dev/null || true)"
        if [ -n "$reused_arch" ] && [ "$reused_arch" != "$ARCH" ]; then
            die "--reuse-image '$REUSE_IMAGE' is a $reused_arch image but this run stages
  for $ARCH, and the staged filename carries $ARCH. Refusing: the artifact would be
  mounted by a runtime that cannot execute it. Pass --arch $reused_arch if that is what
  you meant."
        fi
        TAG="$REUSE_IMAGE"
        t_build_end=$t_build_start
        BUILD_NOTE="skipped (--reuse-image)"
    else
        if [ "$ARCH" != "$HOST_DOCKER_ARCH" ] && [ "${ALLOW_EMULATED_BUILD:-0}" != "1" ]; then
            die "refusing to build a $ARCH image on a $HOST_DOCKER_ARCH host.
  An emulated scientific stack is not something to stage and then measure. Build on a
  native host, or set ALLOW_EMULATED_BUILD=1 if you have qemu configured and mean it."
        fi
        log "building (docker layer cache makes an unchanged recipe cheap) …"
        # The env LABEL is what makes `--reuse-image` safe (see the check above): an
        # image this loop built carries the id it was built from, so re-staging it under
        # a DIFFERENT env can be refused by name instead of silently succeeding.
        docker build \
            --platform "$PLATFORM" \
            -f "$RECIPE" \
            --build-arg "ROOTFS_SCHEMA_VERSION=$SCHEMA" \
            --label "$ENV_LABEL=$id" \
            -t "$TAG" \
            "$ENV_ROOT/$id" >&2
        t_build_end=$(now)
        BUILD_NOTE="$((t_build_end - t_build_start))s"
    fi

    # ── 2/4 extract the packed squashfs ─────────────────────────────────────────
    # The verification happens AFTER this, against the extracted artifact, and NOT via
    # `cyto_verify_image_runs_jq`. That function runs `docker run --entrypoint jq` on
    # the built image, and the built image is the recipe's LAST stage — `packer`, a
    # bare `debian:bookworm-slim` + `squashfs-tools` that holds the rootfs as the
    # SUBDIRECTORY `/rootfs` and the packed artifact as `/rootfs.squashfs`. `jq` is
    # therefore not on that image's PATH for ANY recipe in this tree, and its copy
    # under `/rootfs/usr/bin/jq` cannot execute there either because its loader path is
    # `/rootfs/usr/lib`, not `/usr/lib` ("error while loading shared libraries:
    # libjq.so.1"). Measured on both shipped recipes; reported upstream, not worked
    # around here.
    #
    # The right subject was never the image anyway: what a job mounts is the SQUASHFS,
    # so that is what this asks. See leg 3.
    t_extract_start=$(now)
    staging="$CACHE/.local-build-$id.$$.squashfs"
    CID=$(docker create "$TAG")
    # `docker cp` writes the file; the container is removed whatever happens next, so a
    # failed copy cannot leak a container per run.
    if ! docker cp "$CID:/rootfs.squashfs" "$staging"; then
        docker rm "$CID" >/dev/null 2>&1 || true
        rm -f "$staging"
        die "the built image has no /rootfs.squashfs to extract.
  The recipe's packer stage is what produces it (see its mksquashfs step)."
    fi
    docker rm "$CID" >/dev/null 2>&1 || true
    [ -s "$staging" ] || { rm -f "$staging"; die "the extracted squashfs is empty."; }
    t_extract_end=$(now)

    # ── 3/4 verify the ARTIFACT — the bytes a job will actually mount ───────────
    # Three questions, in increasing strength, all asked of the artifact rather than of
    # the recipe source. A recipe comment cannot satisfy any of them, which is the whole
    # reason this tier exists (#196).
    for tool in unsquashfs squashfuse bwrap; do
        command -v "$tool" >/dev/null 2>&1 || {
            rm -f "$staging"
            die "\`$tool\` is not on PATH, so the staged artifact cannot be verified.
  Refusing to stage an unverified image rather than warning past it: a loop that stages
  whatever it extracted is a loop that will one day stage a broken image and say PASS.
  Install it (bubblewrap / squashfuse / squashfs-tools) and re-run."
        }
    done

    # (a) the schema marker is a property of the BYTES, not of the recipe that claims to
    #     have written it. This is the contract the runtime's mount probe enforces.
    probe=$(mktemp -d)
    if ! unsquashfs -no-progress -d "$probe/x" -f "$staging" \
             .cytoanalyst-sandbox-rootfs-schema >/dev/null 2>&1; then
        rm -rf "$probe"; rm -f "$staging"
        die "cannot read the schema marker out of the extracted squashfs — it is not a
  readable squashfs image, so nothing downstream could mount it either."
    fi
    got=$(tr -d ' \n' < "$probe/x/.cytoanalyst-sandbox-rootfs-schema" 2>/dev/null || true)
    rm -rf "$probe"
    if [ "$got" != "$SCHEMA" ]; then
        rm -f "$staging"
        die "the built image's schema marker is '${got:-<missing>}' but this binary expects
  $SCHEMA. ROOTFS_SCHEMA_VERSION is the contract; the image does not satisfy it."
    fi
    log "verified: schema marker = $SCHEMA (read from the artifact)"

    # (b) + (c) mount it and RUN something in it, under the sandbox's own bwrap shape —
    #     `/usr` bound read-only, the fixed PATH, no network, `/bin`→`usr/bin` symlinks.
    #     Presence is checked through the SHARED verifier so this is not a second
    #     spelling of that predicate; execution is checked here because presence alone
    #     misses the failure this very loop just exposed one level up: a binary that is
    #     present and cannot run because its loader path is wrong.
    mnt=$(mktemp -d)
    unmount_probe() {
        (fusermount -u "$mnt" 2>/dev/null || fusermount3 -u "$mnt" 2>/dev/null) || true
        rmdir "$mnt" 2>/dev/null || true
    }
    if ! squashfuse "$staging" "$mnt" 2>/dev/null; then
        unmount_probe; rm -f "$staging"
        die "squashfuse could not mount the extracted artifact — the sandbox could not
  mount it either, so staging it would defer a certain failure into a user's job."
    fi
    # shellcheck source=lib/env-image-verify.sh
    . "$REPO_ROOT/scripts/lib/env-image-verify.sh"
    if ! cyto_verify_rootfs_has_jq "$mnt"; then
        unmount_probe; rm -f "$staging"
        die "the staged artifact does not carry jq; not staging it."
    fi
    # The sandbox's own argv (mirrors `modules::sandbox::sandbox::build_bwrap_argv` and
    # `scripts/verify-r-rootfs-local.sh`): /usr ro-bound, /etc bound only with
    # --ro-bind-try, so `/usr` is the only directory an image may depend on.
    jq_out=$(bwrap \
        --unshare-uts --unshare-ipc --unshare-net --new-session --die-with-parent \
        --ro-bind "$mnt/usr" /usr \
        --ro-bind-try "$mnt/opt" /opt \
        --symlink usr/bin /bin --symlink usr/sbin /sbin \
        --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
        --dev /dev --tmpfs /tmp --chdir / \
        --setenv PATH /opt/venv/bin:/usr/local/bin:/usr/bin:/bin \
        --setenv LANG C.UTF-8 \
        -- /bin/sh -c 'jq --version' 2>&1) && jq_rc=0 || jq_rc=$?
    unmount_probe
    if [ "$jq_rc" -ne 0 ]; then
        rm -f "$staging"
        die "jq is present in the artifact but does NOT RUN inside the sandbox's own bwrap
  shape (exit $jq_rc): $jq_out
  A converter wrapper parses /inputs/params.json with it, so this fails every such job
  at RUN time, deep inside a user's sandbox. Presence is not execution — this is exactly
  the distinction the image-level check misses."
    fi
    log "verified BEHAVIOURALLY: jq runs inside the sandbox shape ($jq_out)"

    # ── 4/4 hash it and stage it ────────────────────────────────────────────────
    t_stage_start=$(now)
    # THE HASHER'S OWN STATUS, on the WRITE side too. I fixed this on the READ side in
    # `--print-seam` and left it here, which is the more dangerous half: `sha256sum … |
    # cut` takes CUT's status, cut exits 0 on empty input, so a failing or absent hasher
    # left SHA empty, `set -e` never fired, and an EMPTY sidecar was written beside a
    # perfectly good artifact. `--print-seam` would then report "has no recorded sha256"
    # — fail-closed, but the wrong diagnosis, about a build that silently recorded
    # nothing. Reproduced with a failing shim.
    if ! sha_raw=$(sha256sum "$staging"); then
        rm -f "$staging"
        die "could not hash the artifact just built for '$id'. Refusing to stage it: an
  artifact with no recorded identity cannot be verified at use time, and staging one
  would defer this failure to a later, less obvious place."
    fi
    SHA=${sha_raw%% *}
    [ ${#SHA} -eq 64 ] || { rm -f "$staging"; die "sha256sum produced '$SHA', which is not a
  64-character digest. Refusing to record it as this artifact's identity."; }
    BYTES=$(wc -c < "$staging" | tr -d ' ')
    MIB=$(awk -v b="$BYTES" 'BEGIN { printf "%.1f", b / 1048576 }')
    mv -f "$staging" "$OUT"
    printf '%s' "$SHA" > "${OUT%.squashfs}.sha256"
    t_stage_end=$(now)

    cat >&2 <<EOF
[env-local] STAGED $id
[env-local]   path        : $OUT
[env-local]   packed size : $MIB MiB ($BYTES bytes)
[env-local]   sha256      : $SHA
[env-local]   legs        : build=$BUILD_NOTE extract=$((t_extract_end - t_extract_start))s stage+hash=$((t_stage_end - t_stage_start))s
[env-local]   measured on : load=$BOX_LOAD availableMem=$BOX_FREE
[env-local]                 (timings from a contended box are NOT a budget — see DEC-9)
[env-local]
[env-local] Hand it to the runtime's air-gap seam. NOTE the \`env\` form: the env id
[env-local] contains '-', so this variable is not a legal shell identifier and neither
[env-local] \`export\` nor an assignment prefix can set it.
[env-local]
[env-local]   $(seam_line_for "$id") <your command>
[env-local]
[env-local] Verification posture: seam 1 has NO signature in its path. These are bytes you
[env-local] built; nothing cosign-verified them, and they are NOT signed by the CI OIDC
[env-local] identity a deployment's release policy pins. Development only — publishing is
[env-local] still gated (#80).
EOF
    echo "$OUT" >> "$STAGED_LIST"
  )
  env_rc=$?
  set -e
  if [ "$env_rc" -ne 0 ]; then
      overall_rc=1
      FAILED="$FAILED $id"
      # Only say "continuing" when there is something to continue TO. On a single-env run
      # this printed multi-env language and then buried the real `die` under a generic
      # "nothing was staged", so the last line the operator saw explained nothing.
      if [ "$N_TARGETS" -gt 1 ]; then
          log "!! $id FAILED. Continuing with the remaining env(s) — see the summary below."
      fi
  fi
done

if [ -n "$FAILED" ] && [ "$N_TARGETS" -gt 1 ]; then
    log "=============================================================="
    log "FAILED env(s):$FAILED"
    log "Staged successfully: $(wc -l < "$STAGED_LIST" | tr -d ' ') of $N_TARGETS"
    log "=============================================================="
fi

# The last line is the staged path, so `sq=$(... | tail -1)` works — the same contract
# `fetch-env-rootfs.sh` offers. NOTE for callers: reading it through a pipe DISCARDS the
# exit status ($? is the pipe's last stage), and with --all a partial failure exits
# non-zero while still printing a path. Capture the status, then read the file.
# On a single-env run the per-env failure above already printed the real reason, so this
# must not overwrite it with a generic one — it says so instead of restating it.
if [ ! -s "$STAGED_LIST" ]; then
    if [ -n "$FAILED" ]; then
        printf '[env-local] FAIL: nothing was staged — see the failure reported above for%s.\n' "$FAILED" >&2
        exit 1
    fi
    die "nothing was staged."
fi
tail -1 "$STAGED_LIST"
exit $overall_rc
