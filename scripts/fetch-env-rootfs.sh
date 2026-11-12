#!/usr/bin/env bash
# fetch-env-rootfs.sh — fetch + cache an analysis ENV IMAGE squashfs, ONCE.
#
# WHY THIS EXISTS
# ---------------
# The real-compute test tier (`just e2e-processors`) runs a processor inside a
# REAL bwrap sandbox against a REAL analysis rootfs. `modules::sandbox::env_image`
# documents two air-gap seams for supplying that rootfs; seam 1 is the preferred
# one:
#
#   1. TXR_ENV_ROOTFS_SQUASHFS=<file>  — content-hashed, digest RECORDED, mounted
#      BY DIGEST. A run under it is fully reproducible and its export capsule
#      EXECUTES.
#   2. TXR_ENV_ROOTFS_DIR=<mounted dir> — legacy. No content identity, so the run
#      is UNPINNED and its capsule is provenance-only.
#
# This script produces the seam-1 artifact: the `.squashfs` FILE. The published
# env image is an OCI artifact whose single layer IS that squashfs, so "fetch the
# image" is literally "pull one blob" — no docker build, no mksquashfs, no
# conversion step.
#
# COST — measured, not estimated: the analysis env image this tree declares today is
# ~300 MB and pulls in ~5 s on a warm link. It is then cached forever (see CACHE
# below). The belief that this tier was expensive to stand up was wrong; the tier was
# simply never built.
#
# CACHE
# -----
#   .txr-cache/env-rootfs/<env>-schema<N>-<arch>.squashfs   (the artifact)
#   .txr-cache/env-rootfs/<env>-schema<N>-<arch>.digest     (the OCI digest it came from)
#
# Re-running is a no-op when the cached digest still matches the registry's
# moving `schema<N>-latest-<arch>` tag. `--offline` skips the registry entirely
# and accepts whatever is cached (for a box with no network / no token).
#
# AUTH
# ----
# `ghcr.io/tinnlab/txresbench-env/*` is NOT anonymously pullable — without a credential
# the registry answers `unauthorized: authentication required`. The script tries,
# in order:
#   1. an existing `oras login` credential (docker/oras config)
#   2. `gh auth token` (the GitHub CLI, if logged in — needs `read:packages`)
#   3. $GITHUB_TOKEN / $GH_TOKEN
# and fails LOUDLY with the exact remediation if none works.
#
# THE ENV-ID IS DERIVED, NEVER TYPED HERE
# ---------------------------------------
# Which analysis env image to fetch is DATA: a processor declares it as
# `contributes.converters[].env` OR `contributes.analyses[].env` in its `manifest.yaml`,
# and that same UNION is what the binary reads
# (`sandbox::env_image::declared_envs_in()`, the shared core of `default_env_id()` and
# `declared_env_ids()` — "the app carries no env-name literal"). This script reads it the
# same way, so adding a second analysis domain is a processor-package change with zero
# edits to this file or to the `justfile`.
#
# With no argument the resolution is, in order:
#   1. an explicit `<env-id>` argument
#   2. $TXR_SANDBOX_ENV_ID          (the same operator override the binary honours first)
#   3. the SOLE declared env-id      — when exactly one exists, using it CHOOSES nothing
#   4. otherwise: REFUSE, and name the candidates
# Step 4 is the point. A second declared env makes this recipe ASK instead of silently
# fetching whichever env happened to be declared first — the fail direction that cannot
# quietly run a domain against the wrong image. (`default_env_id()` takes the first
# declaration because a running converter always names its own env; this script has no
# converter in hand, so it has no such tiebreak and must not invent one.)
#
# USAGE
#   scripts/fetch-env-rootfs.sh                 # the declared env, resolve+pull if stale
#   scripts/fetch-env-rootfs.sh <env-id>        # a specific env id
#   scripts/fetch-env-rootfs.sh --offline       # use the cache, never touch the network
#   scripts/fetch-env-rootfs.sh --print-path    # print the cached path and exit
#
# Prints the artifact path on the last line, so a caller can do:
#   export TXR_ENV_ROOTFS_SQUASHFS=$(scripts/fetch-env-rootfs.sh --print-path)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ENV_ID=""
OFFLINE=0
PRINT_PATH_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --offline)     OFFLINE=1 ;;
    --print-path)  PRINT_PATH_ONLY=1 ;;
    # The header block, DERIVED (every comment line from line 2 to the first line that is
    # neither a comment nor blank). It was a hardcoded `2,50p`, which this file outgrew the
    # moment the header explaining the derived env-id was added: `--help` then stopped
    # printing USAGE at all. A line-number literal in a `--help` is a stale doc waiting to
    # happen.
    -h|--help)     awk 'NR > 1 { if ($0 !~ /^#/ && $0 != "") exit; print }' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*)            echo "fetch-env-rootfs: unknown flag $arg" >&2; exit 2 ;;
    *)             ENV_ID="$arg" ;;
  esac
done

# ── the ENV-ID: DERIVED from the processor manifests (see the header) ────────────
# An indentation-exact reader for the UNION of `contributes.converters[].env` and
# `contributes.analyses[].env`, deliberately the same shape as the one in
# `scripts/check-derived-vocabulary.sh` (and the same union
# `sandbox::env_image::declared_envs_in` reads): no YAML dependency, because a
# gate/recipe a transitive dep bump can break is a worse one.
#
# #196: this read the `converters:` block ALONE, which made the script that exists to
# fetch an env unable to NAME an env declared by an analysis (#189's twin field) — it
# reported "no processor manifest declares an env image" about a manifest that declares
# exactly that, and the >1 refuse-and-name path listed only half the candidates. Reading
# one half of a union is worse than reading neither: it fails while looking like it
# derived.
#
# Loop shape note: a `  analyses:` line both ENDS the `converters:` block and OPENS its
# own, so the block-exit test must fall through to the header test rather than `next`.
# Sourced from the REPO ROOT this script already computed, not from `$(dirname "$0")`:
# `$0` is symlink- and cwd-fragile, and a guard that cannot find its own library must not
# be the thing that decides an env id is malformed.
# shellcheck source=lib/env-id-grammar.sh
. "$ROOT/scripts/lib/env-id-grammar.sh"
# shellcheck source=lib/env-image-verify.sh
. "$ROOT/scripts/lib/env-image-verify.sh"

# Refuses a derived id that is not a legal env id. A YAML shape the block reader
# mis-parses (a folded scalar, an anchor/alias, a flow map) yields something like `>-` or
# `*E`; without this it would be COUNTED as a declaration and flow into PULL_REF. #196 R7.
# $2 names the CHANNEL the id came from, so the diagnosis sends the reader to the right
# place: a manifest to edit, or the override they just typed.
_refuse_malformed_env_id() {
  txr_is_valid_env_id "$1" && return 0
  echo "[env-rootfs] FAIL: malformed env id from ${2:-a processor manifest}: '$1'" >&2
  echo "  A legal env id is a non-empty OCI path component: lowercase a-z, 0-9, and . _ -" >&2
  echo "  (the grammar in src-app/server/src/modules/sandbox/env_id.rs)." >&2
  echo "" >&2
  echo "  If it came from a manifest, that manifest almost certainly uses a YAML shape" >&2
  echo "  the indentation-exact" >&2
  echo "  block reader cannot see — a flow map \`- {id: x, env: y}\`, a quoted key, a" >&2
  echo "  folded scalar or an anchor/alias. Rewrite that \`env:\` as a plain block scalar." >&2
  echo "  Refusing rather than building an image reference out of it." >&2
  exit 1
}

declared_env_ids() {
  local mf
  for mf in "$ROOT"/src-app/packages/*/manifest.yaml; do
    [ -f "$mf" ] || continue
    awk '
      /^[[:space:]]*(#|$)/ { next }
      {
        line = $0
        indent = match(line, /[^ ]/) - 1
        if (inblock && indent <= 2) inblock = 0
        if (!inblock) {
          if (indent == 2 && line ~ /^  (converters|analyses):[[:space:]]*$/) inblock = 1
          next
        }
        if (match(line, /^(      env:|    - env:)[[:space:]]*/)) {
          id = substr(line, RSTART + RLENGTH)
          # A YAML scalar read the way a YAML parser reads it: a QUOTED value ends at its
          # own closing quote; an UNQUOTED one ends at an inline `#` comment. Stripping
          # only trailing whitespace and one quote at each end was FAIL-OPEN: `env: x # n`
          # resolved to the id `x # n`, and this script would then build an OCI reference
          # out of a string containing spaces and a `#`. Sibling of the reader in
          # `scripts/check-derived-vocabulary.sh`, byte-for-byte in intent.
          q = substr(id, 1, 1)
          if (q == "\"" || q == "\047") {
            rest = substr(id, 2)
            p = index(rest, q)
            id = (p > 0) ? substr(rest, 1, p - 1) : rest
          } else {
            p = index(id, "#")
            if (p > 0) id = substr(id, 1, p - 1)
            sub(/[[:space:]]+$/, "", id)
          }
          if (id != "") print id
        }
      }
    ' "$mf"
  done | sort -u
}

if [ -z "$ENV_ID" ]; then
  ENV_ID="${TXR_SANDBOX_ENV_ID:-}"
fi
if [ -z "$ENV_ID" ]; then
  DECLARED="$(declared_env_ids)"
  # Validate EVERY derived id before any of them is used or counted (#196 R7). A shape
  # the block reader mis-parses yields a non-id like `>-` or `*E`, which would otherwise
  # be counted as a declaration and built into a pull reference.
  while IFS= read -r _id; do
    [ -n "$_id" ] || continue
    _refuse_malformed_env_id "$_id" "a processor manifest"
  done <<EOF
$DECLARED
EOF
  n_declared="$(printf '%s\n' "$DECLARED" | grep -c . || true)"
  if [ "$n_declared" -eq 1 ]; then
    ENV_ID="$DECLARED"
  elif [ "$n_declared" -eq 0 ]; then
    # ANTI-VACUITY. A collapsed parse must refuse, never fall back to a guessed id:
    # this is the branch that would otherwise let a broken reader look like an
    # undeclared tree. It is reached both when nothing is declared and when the reader
    # stops seeing what is.
    echo "[env-rootfs] FAIL: no processor manifest declares an env image, so there is" >&2
    echo "  nothing to fetch. An env-id is DATA: declare it as \`env: <id>\` on a CONVERTER" >&2
    echo "  or an ANALYSIS in src-app/packages/<pkg>/manifest.yaml (the union the binary" >&2
    echo "  reads too — sandbox::env_image::declared_envs_in), or name one explicitly:" >&2
    echo "      scripts/fetch-env-rootfs.sh <env-id>" >&2
    echo "  If a manifest DOES declare one, this reader has drifted from the manifests." >&2
    exit 1
  else
    echo "[env-rootfs] FAIL: $n_declared env images are declared, so the env to fetch is a" >&2
    echo "  CHOICE and this script will not make it for you. Name one:" >&2
    printf '%s\n' "$DECLARED" | sed 's/^/      scripts\/fetch-env-rootfs.sh /' >&2
    echo "  (or set TXR_SANDBOX_ENV_ID, the same override the server honours)." >&2
    exit 1
  fi
fi
# #196 R7 — validate the RESOLVED env id whatever channel supplied it. The validation
# above runs only on DERIVED ids, so a positional argument or `TXR_SANDBOX_ENV_ID` flowed
# straight into PULL_REF and the cache path unchecked: `single-cell:evil` smuggles a tag
# into the reference, and `../../../other/repo` escapes the cache directory. `env_id.rs`
# states that stopping exactly that is the grammar's purpose, and the operator channel is
# the one that most needs it. Caught by a blind verifier.
_refuse_malformed_env_id "$ENV_ID" "the env-id you supplied (argument or TXR_SANDBOX_ENV_ID)"

REGISTRY="${TXR_ENV_REGISTRY:-ghcr.io/tinnlab/txresbench-env}"
CACHE="${TXR_ENV_ROOTFS_CACHE:-$ROOT/.txr-cache/env-rootfs}"

# The schema version is read from the RUST CONSTANT, not duplicated here — a
# schema bump in the binary must not silently keep pulling the old image.
VERSION_RS="$ROOT/src-app/server/src/modules/rootfs/version.rs"
SCHEMA="$(sed -n 's/.*ROOTFS_SCHEMA_VERSION: u32 = \([0-9]\+\).*/\1/p' "$VERSION_RS" | head -1)"
if [ -z "$SCHEMA" ]; then
  echo "fetch-env-rootfs: FAILED to read ROOTFS_SCHEMA_VERSION from $VERSION_RS" >&2
  echo "  The schema version is the contract between the binary and the image;" >&2
  echo "  refusing to guess it." >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64)          ARCH="amd64" ;;
  aarch64|arm64)   ARCH="arm64" ;;
  *)               echo "fetch-env-rootfs: unsupported arch $(uname -m)" >&2; exit 1 ;;
esac
ARCH="${TXR_ENV_ARCH:-$ARCH}"

TAG="schema${SCHEMA}-latest-${ARCH}"
PULL_REF="${REGISTRY}/${ENV_ID}:${TAG}"
OUT="$CACHE/${ENV_ID}-schema${SCHEMA}-${ARCH}.squashfs"
DIGEST_FILE="${OUT%.squashfs}.digest"

if [ "$PRINT_PATH_ONLY" -eq 1 ]; then echo "$OUT"; exit 0; fi

log() { printf '[env-rootfs] %s\n' "$*" >&2; }

# The CONTENT sha256 sidecar (E5 / #193), written wherever this script decides an artifact
# is good — the fresh pull, a cache HIT, and `--offline`. It was on the pull path ONLY,
# which made it unreachable in the two cases that matter most: a box that has fetched
# before takes the cache-hit `exit 0` and an air-gapped box takes the `--offline` one, so
# neither ever grew a sidecar, and `--print-seam`'s "re-fetch to record one" hint was a
# remedy that could not work — a false diagnosis pointing at a no-op.
#
# Distinct from `<name>.digest`: that is the registry MANIFEST digest, this is the sha256
# of the squashfs bytes — the same identity `env_image::squashfs_content_digest` computes
# when the runtime mounts it. Best-effort: a missing hasher costs the sidecar, never the
# fetch, and a partial write is removed rather than left to be trusted.
#
# ── WHAT IT DOES AND DOES NOT PROVE, because the two are easy to conflate ───────────
# On the FRESH-PULL path the bytes were just pulled by digest and cosign-verified, so the
# recorded hash is an identity for a verified artifact. On the CACHE-HIT and `--offline`
# paths it is a BOOTSTRAP: this script compared the cached DIGEST to the registry (or, when
# offline, to nothing at all) and never re-read the file, so what is recorded is whatever
# is on disk now. Corruption that happened BEFORE the bootstrap is therefore not detected
# by it; corruption AFTER is. That is still strictly better than no sidecar — without one,
# `--print-seam` cannot check a fetched artifact at all — but it is not provenance, and it
# must not be read as such. An existing sidecar is never overwritten, so a good recording
# cannot be quietly replaced by a later, worse one (nor a multi-hundred-MB file re-hashed
# on every cache hit).
record_content_sha256() {
  _art="$1"
  command -v sha256sum >/dev/null 2>&1 || return 0
  [ -s "$_art" ] || return 0
  _side="${_art%.squashfs}.sha256"
  [ -s "$_side" ] && return 0   # already recorded; do not re-hash a multi-hundred-MB file
  if _raw="$(sha256sum "$_art")"; then
    printf '%s' "${_raw%% *}" > "$_side" || rm -f "$_side"
  else
    rm -f "$_side"
  fi
}


# ── cached? ──────────────────────────────────────────────────────────────────
cached_digest=""
[ -f "$DIGEST_FILE" ] && cached_digest="$(cat "$DIGEST_FILE")"
have_cache=0
if [ -s "$OUT" ] && [ -n "$cached_digest" ]; then have_cache=1; fi

if [ "$OFFLINE" -eq 1 ]; then
  if [ "$have_cache" -eq 1 ]; then
    log "offline: using cached $OUT ($cached_digest)"
    record_content_sha256 "$OUT"
    echo "$OUT"; exit 0
  fi
  echo "[env-rootfs] FAIL: --offline but no cached image at $OUT" >&2
  echo "  Run without --offline once, on a box with network + a GitHub token." >&2
  exit 1
fi

command -v oras >/dev/null 2>&1 || {
  echo "[env-rootfs] FAIL: \`oras\` not on PATH (needed to pull the OCI env image)." >&2
  echo "  Install: https://oras.land/docs/installation  (or use --offline with a pre-staged file)" >&2
  exit 1
}

# ── auth ─────────────────────────────────────────────────────────────────────
# Try an anonymous resolve first; only log in if it is refused. Never put a token on argv.
registry_host="${REGISTRY%%/*}"
try_resolve() { oras resolve "$PULL_REF" 2>/dev/null; }

digest="$(try_resolve || true)"
if [ -z "$digest" ]; then
  log "anonymous resolve failed for $PULL_REF — authenticating to $registry_host"
  token=""; token_src=""
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    token="$(gh auth token 2>/dev/null || true)"; token_src="gh auth token"
  fi
  if [ -z "$token" ]; then
    token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"; [ -n "$token" ] && token_src="\$GITHUB_TOKEN/\$GH_TOKEN"
  fi
  if [ -z "$token" ]; then
    cat >&2 <<EOF
[env-rootfs] FAIL: cannot pull $PULL_REF and no credential is available.

  ghcr.io/tinnlab/txresbench-env/* is NOT anonymously pullable (registry answers: unauthorized).

  Fix ONE of these, then re-run:
    * gh auth login                 # GitHub CLI, with the read:packages scope
    * export GITHUB_TOKEN=<PAT>     # a PAT carrying read:packages
    * scripts/fetch-env-rootfs.sh --offline   # if you pre-staged the .squashfs yourself
EOF
    exit 1
  fi
  user="${GITHUB_ACTOR:-$(gh api user --jq .login 2>/dev/null || echo oauth)}"
  printf '%s' "$token" | oras login "$registry_host" -u "$user" --password-stdin >/dev/null 2>&1 || {
    echo "[env-rootfs] FAIL: \`oras login $registry_host\` rejected the credential from $token_src." >&2
    echo "  The token most likely lacks the read:packages scope." >&2
    exit 1
  }
  log "authenticated to $registry_host via $token_src"
  digest="$(try_resolve || true)"
fi

if [ -z "$digest" ]; then
  echo "[env-rootfs] FAIL: could not resolve $PULL_REF even after authenticating." >&2
  echo "  Check the env id ('$ENV_ID'), schema ($SCHEMA) and arch ($ARCH) — the tag is '$TAG'." >&2
  exit 1
fi
log "registry digest for $PULL_REF: $digest"

# ── skip-if-fresh ────────────────────────────────────────────────────────────
if [ "$have_cache" -eq 1 ] && [ "$cached_digest" = "$digest" ]; then
  log "cache HIT ($OUT) — nothing to do"
  record_content_sha256 "$OUT"
  echo "$OUT"; exit 0
fi
[ "$have_cache" -eq 1 ] && log "cache STALE (cached $cached_digest != registry $digest) — re-pulling"

# ── pull ─────────────────────────────────────────────────────────────────────
mkdir -p "$CACHE"
staging="$(mktemp -d "$CACHE/.pull.XXXXXX")"
cleanup() { rm -rf "$staging"; }
trap cleanup EXIT

log "pulling $PULL_REF ..."
oras pull "$PULL_REF" --output "$staging" >&2

pulled="$(find "$staging" -maxdepth 1 -name '*.squashfs' -type f | head -1)"
if [ -z "$pulled" ]; then
  echo "[env-rootfs] FAIL: the pulled artifact contains no .squashfs layer." >&2
  find "$staging" -maxdepth 2 >&2
  exit 1
fi

# ── verify: the image must actually mount and carry the schema we expect ─────
# A wrong-schema image is the failure that otherwise shows up much later as an
# opaque job error, so pay the check here where the message can be precise.
if command -v squashfuse >/dev/null 2>&1; then
  probe="$staging/.probe"; mkdir -p "$probe"
  if squashfuse "$pulled" "$probe" 2>/dev/null; then
    marker="$probe/.txresbench-sandbox-rootfs-schema"
    got="$(cat "$marker" 2>/dev/null | tr -d '[:space:]' || true)"
    # `/opt/venv/bin/python` is an ABSOLUTE symlink (-> /usr/local/bin/python3.11).
    # From outside the sandbox that target resolves against the HOST root, so `-e`/`-x`
    # are both false on a perfectly good image; inside bwrap it resolves because /usr is
    # bound. Test the link itself, then the real interpreter under the probe.
    have_py=0
    if { [ -L "$probe/opt/venv/bin/python" ] || [ -e "$probe/opt/venv/bin/python" ]; } \
       && ls "$probe"/usr/local/bin/python3* >/dev/null 2>&1; then have_py=1; fi
    # #196 R7 — a property of the ARTIFACT, not of the recipe source. Delegated to the
    # shared verifier rather than inlined: an inline copy would be a second spelling of
    # one predicate, which is the mirror-drift this branch's own parity test exists to
    # prevent one level up. A blind verifier caught the first version doing exactly that.
    have_jq=0
    if txr_verify_rootfs_has_jq "$probe" 2>/dev/null; then have_jq=1; fi
    (fusermount -u "$probe" 2>/dev/null || fusermount3 -u "$probe" 2>/dev/null) || true
    if [ "$got" != "$SCHEMA" ]; then
      echo "[env-rootfs] FAIL: image schema marker is '${got:-<missing>}' but this binary expects $SCHEMA." >&2
      echo "  ROOTFS_SCHEMA_VERSION in $VERSION_RS is the contract; the image does not satisfy it." >&2
      exit 1
    fi
    if [ "$have_jq" -ne 1 ]; then
      echo "[env-rootfs] FAIL: no jq binary in the pulled image — a converter wrapper" >&2
      echo "  cannot parse params.json. Checked /usr/bin, /bin, /usr/local/bin. This reads" >&2
      echo "  the ARTIFACT received, so no recipe comment can satisfy it (#196 R7)." >&2
      exit 1
    fi
    if [ "$have_py" -eq 1 ]; then
      log "verified: schema=$SCHEMA, /opt/venv interpreter present, jq present"
    else
      log "WARN: no /opt/venv interpreter found — processors expecting the venv will fail"
    fi
  else
    log "WARN: could not squashfuse-mount the pulled image for verification (continuing)"
  fi
else
  log "WARN: squashfuse not on PATH — skipping the mount/schema verification"
fi

mv -f "$pulled" "$OUT"
printf '%s' "$digest" > "$DIGEST_FILE"
record_content_sha256 "$OUT"
log "cached: $OUT ($(du -h --apparent-size "$OUT" 2>/dev/null | cut -f1 || echo '?'), $digest)"
echo "$OUT"
