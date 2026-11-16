#!/usr/bin/env bash
#
# publish-method-list.sh — sign and publish the method list (maintainers only).
#
# The list (method-list.json: the catalogue + the environment images list, nested) lives in
# the methods repository, folder method-list/; a change to it is a methods-repository PR,
# merged by the owner with a merge commit. This script publishes what the METHODS
# repository's origin/main holds, never a working tree, to
# ghcr.io/tinnlab/txresbench-method-list:
#   v1-seq-<NNNNNN>  immutable, one per list (the list + its minisign signature in ONE
#                    artifact, artifact type application/vnd.txresbench.method-list.v1);
#   v1               moving, set last: what installed apps fetch.
#
# Steps (each refusal stops the run; nothing is signed or pushed before a-d pass):
#   a. this app checkout is clean and at its origin/main (the current tools); the methods
#      checkout is clean and its method-list/ files equal the methods repository's
#      origin/main copies (the merged PR is the lock). The files are then read from
#      origin/main itself.
#   b. the methods-repository checks: scripts/check-method-list.sh --list-dir (header,
#      nested documents, rules, parity, size), scripts/check-method-env-images.sh
#      --require-provenance against the methods repository, the app's own loader
#      (`txresbench check-method-list` over an unsigned sequence 0 copy of the same two
#      documents), the list has bases (rule 4), and every entry's source_revision is an
#      ancestor of the methods origin/main (rule 6).
#   c. anonymously resolve, pull and verify the published :v1; the local sequence must be
#      above it (equal + same bytes = already published, exit 0; lower = superseded), and
#      the list keeps every row and same-version fact of the published one.
#      `--first-publish` is required when nothing is published yet (GHCR answers an
#      anonymous request for a missing package like one for a private package).
#   d. anonymously resolve every layer and base tag the list names: each must give its
#      pinned digest.
#   e. SIGN in a scrubbed environment: `env -i PATH HOME minisign -S` with the trusted
#      comment `txresbench-method-list format=1 sequence=<N>`; the password is asked at
#      the prompt. GHCR_TOKEN is not read before this step and is never in the signer's
#      environment.
#   f. verify the signature with `minisign -V -H` (the signer's public key from
#      data/method-list/trusted-keys.json) and with `txresbench check-method-list`.
#   g. push v1-seq-<N> with the token in a temporary registry config (mode 600, removed
#      on exit; never `oras login`), with the annotations
#      org.opencontainers.image.source=https://github.com/tinnlab/txresbench-methods and
#      org.opencontainers.image.revision=<methods origin/main commit>. The pushed tag must
#      then read back anonymously, as apps read it (a package's first push creates it
#      private: make it public and rerun; the rerun finds the push and only moves v1).
#   h. re-resolve :v1: if it moved since c, stop and print both sequences; else tag v1.
#   i. anonymously pull :v1 and byte-compare both files; print what changed.
#
# Usage:
#   scripts/publish-method-list.sh --methods-dir <methods checkout> [--dry-run]
#       [--key <minisign secret key>] [--first-publish] [--cli <txresbench binary>]
#       [--registry 127.0.0.1:<port> [--keys <trusted-keys file>]]
#
#   --dry-run          run a-d (read only), print e-i, sign and push nothing
#   --key FILE         default ~/.minisign/txresbench-method-list.key; refused when group-
#                      or world-readable
#   --registry H:P     rehearse on a loopback registry (127.0.0.1:<port> or [::1]:<port>):
#                      plain HTTP, no token; `--keys` may then name another trusted-keys file
#                      (a test key), never on ghcr.io
#   --cli PATH         the txresbench binary (or TXR_CLI); default: cargo run from this
#                      checkout
#   GHCR_USER, GHCR_TOKEN  a classic token with write:packages (read only at step g)
#
# Exit: 0 published (or dry run / already published); 1 a refusal; 2 usage or tooling.
set -euo pipefail

REPO=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
PACKAGE="ghcr.io/tinnlab/txresbench-method-list"
LINE="v1"
FORMAT_VERSION=1
ARTIFACT_TYPE="application/vnd.txresbench.method-list.v1"
LIST_MEDIA="application/vnd.txresbench.method-list.v1+json"
SIG_MEDIA="application/vnd.txresbench.method-list.signature.v1"
SOURCE_URL="https://github.com/tinnlab/txresbench-methods"

METHODS_DIR=""
KEY="${HOME:-}/.minisign/txresbench-method-list.key"
DRY_RUN=0
FIRST=0
LOOPBACK=""
KEYS_FILE=""
CLI="${TXR_CLI:-}"

usage() { awk 'NR == 1 { next } /^[^#]/ { exit } { sub(/^# ?/, ""); print }' "$0"; }
die() { echo "publish-method-list: $*" >&2; exit 1; }
usage_error() { echo "publish-method-list: $*" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --methods-dir) METHODS_DIR=${2-}; shift 2 ;;
    --key) KEY=${2-}; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --first-publish) FIRST=1; shift ;;
    --registry) LOOPBACK=${2-}; shift 2 ;;
    --keys) KEYS_FILE=${2-}; shift 2 ;;
    --cli) CLI=${2-}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage_error "unknown argument: $1" ;;
  esac
done

[ -n "$METHODS_DIR" ] || usage_error "--methods-dir <the methods repository checkout> is required"
if [ -n "$LOOPBACK" ]; then
  loopback_re='^(127\.0\.0\.1|\[::1\]):[0-9]{1,5}$'
  [[ $LOOPBACK =~ $loopback_re ]] || usage_error "--registry must be 127.0.0.1:<port> or [::1]:<port> (a rehearsal); got '$LOOPBACK'"
fi
if [ -n "$KEYS_FILE" ]; then
  [ -n "$LOOPBACK" ] || usage_error "--keys (another trusted-keys file) is for a loopback rehearsal only"
  [ -f "$KEYS_FILE" ] || usage_error "--keys $KEYS_FILE: no such file"
fi
for tool in git python3 oras; do
  command -v "$tool" >/dev/null 2>&1 || usage_error "$tool not found"
done
if [ "$DRY_RUN" = 0 ]; then
  command -v minisign >/dev/null 2>&1 || usage_error "minisign not found (https://jedisct1.github.io/minisign/)"
fi
export PYTHONDONTWRITEBYTECODE=1

WORK=$(mktemp -d "${TMPDIR:-/tmp}/publish-method-list.XXXXXX")
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT
mkdir -p "$WORK/list-dir" "$WORK/published" "$WORK/out" "$WORK/check" "$WORK/auth"
chmod 700 "$WORK/auth"
EMPTY_CONFIG="$WORK/empty-registry-config.json"
printf '{}' > "$EMPTY_CONFIG"

# A ghcr.io ref, or the loopback host in its place for a rehearsal.
target() { if [ -n "$LOOPBACK" ]; then printf '%s/%s' "$LOOPBACK" "${1#ghcr.io/}"; else printf '%s' "$1"; fi; }
REF=$(target "$PACKAGE")
plain=()
[ -z "$LOOPBACK" ] || plain=(--plain-http)
# Anonymous oras: the empty registry config, so no Docker login or credential helper is read.
oras_anon() { local sub=$1; shift; oras "$sub" --registry-config "$EMPTY_CONFIG" ${plain[@]+"${plain[@]}"} "$@"; }

cli() {
  if [ -n "$CLI" ]; then
    "$CLI" "$@"
  else
    cargo run --quiet --manifest-path "$REPO/src-app/server/Cargo.toml" --bin txresbench -- "$@"
  fi
}
cli_keys=()
[ -z "$KEYS_FILE" ] || cli_keys=(--keys "$KEYS_FILE")
field() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$1" "$2"; }

# ── a. the two checkouts ────────────────────────────────────────────────────────
echo "== a. checkouts"
git -C "$REPO" fetch --quiet origin main || die "cannot fetch this app checkout's origin"
[ -z "$(git -C "$REPO" status --porcelain)" ] || die "this app checkout ($REPO) has uncommitted changes: publish with the tools of origin/main, unchanged"
app_head=$(git -C "$REPO" rev-parse HEAD)
app_main=$(git -C "$REPO" rev-parse refs/remotes/origin/main)
[ "$app_head" = "$app_main" ] || die "this app checkout is at ${app_head:0:12}, not its origin/main ${app_main:0:12}: publish with the current tools"
top=$(git -C "$METHODS_DIR" rev-parse --show-toplevel 2>/dev/null) || usage_error "$METHODS_DIR is not a git checkout"
[ "$(cd "$top" && pwd -P)" = "$(cd "$METHODS_DIR" && pwd -P)" ] || usage_error "$METHODS_DIR is not the top of its checkout"
git -C "$METHODS_DIR" fetch --quiet origin main || die "cannot fetch the methods checkout's origin"
[ -z "$(git -C "$METHODS_DIR" status --porcelain)" ] || die "the methods checkout has uncommitted changes"
METHODS_COMMIT=$(git -C "$METHODS_DIR" rev-parse refs/remotes/origin/main)
for f in catalogue.json method-env-images.json method-list.json; do
  git -C "$METHODS_DIR" show "$METHODS_COMMIT:method-list/$f" > "$WORK/list-dir/$f" 2>/dev/null \
    || die "method-list/$f is not on the methods repository's origin/main: merge the list PR first"
  cmp -s "$WORK/list-dir/$f" "$METHODS_DIR/method-list/$f" \
    || die "method-list/$f in the methods checkout is not the methods repository's origin/main copy: only a merged list is published"
done
LOCAL_SEQ=$(field "$WORK/list-dir/method-list.json" sequence) || die "method-list.json has no sequence"
TAG="$LINE-seq-$(printf '%06d' "$LOCAL_SEQ")"
echo "app ${app_head:0:12} = origin/main; methods origin/main ${METHODS_COMMIT:0:12}; list sequence $LOCAL_SEQ"

# ── b. the methods-repository checks ────────────────────────────────────────────
echo "== b. checks"
"$REPO/scripts/check-method-list.sh" --list-dir "$WORK/list-dir" || die "the list guard refused"
"$REPO/scripts/check-method-env-images.sh" --manifest "$WORK/list-dir/method-env-images.json" \
  --methods-dir "$METHODS_DIR" --require-provenance || die "the images guard refused"
python3 - "$WORK/list-dir/method-env-images.json" <<'PY' || exit 1
import json, sys
doc = json.load(open(sys.argv[1]))
if not doc.get("bases"):
    print("publish-method-list: LIST_NO_BASES: the images list pins no base, so no layer of it "
          "could run (rule 4); publish after the full rebuild with bases", file=sys.stderr)
    sys.exit(1)
PY
python3 "$REPO/scripts/assemble-method-list.py" --bootstrap --catalogue "$WORK/list-dir/catalogue.json" \
  --images "$WORK/list-dir/method-env-images.json" --out "$WORK/precheck.json" >/dev/null
cli check-method-list --list "$WORK/precheck.json" >/dev/null || die "the app's loader refused the documents"
echo "the app's loader accepts both documents"
for rev in $(python3 -c 'import json,sys; print(" ".join(sorted({e["source_revision"] for e in json.load(open(sys.argv[1]))["envs"]})))' "$WORK/list-dir/method-env-images.json"); do
  commit=$(git -C "$METHODS_DIR" rev-parse --verify --quiet "$rev^{commit}") \
    || die "LIST_SOURCE_REVISION: commit $rev is not in the methods repository"
  git -C "$METHODS_DIR" merge-base --is-ancestor "$commit" "$METHODS_COMMIT" \
    || die "LIST_SOURCE_REVISION: commit $rev is not on the methods repository's main (rule 6: merge with a merge commit, never squash or rebase)"
done
echo "every source_revision is on the methods main"

# ── c. the published list ───────────────────────────────────────────────────────
echo "== c. published $REF:$LINE"
PUBLISHED_DIGEST=$(oras_anon resolve "$REF:$LINE" 2>/dev/null || true)
PUBLISHED_SEQ=""
if [ -z "$PUBLISHED_DIGEST" ]; then
  [ "$FIRST" = 1 ] || die "$REF:$LINE does not resolve. If nothing is published yet, pass --first-publish; otherwise check the network (an anonymous request for a missing package and for a private one look the same)"
  echo "nothing published yet (--first-publish)"
else
  [ "$FIRST" = 0 ] || die "--first-publish, but $REF:$LINE exists ($PUBLISHED_DIGEST)"
  oras_anon pull "$REF@$PUBLISHED_DIGEST" -o "$WORK/published" >/dev/null || die "cannot pull $REF@$PUBLISHED_DIGEST"
  [ "$(ls -A "$WORK/published" | sort | tr '\n' ' ')" = "method-list.json method-list.json.minisig " ] \
    || die "the published artifact is not exactly method-list.json + method-list.json.minisig"
  report=$(cli check-method-list --list "$WORK/published/method-list.json" \
    --signature "$WORK/published/method-list.json.minisig" ${cli_keys[@]+"${cli_keys[@]}"}) \
    || die "the published list does not verify"
  PUBLISHED_SEQ=$(printf '%s\n' "$report" | awk -F': ' '$1 == "sequence" { print $2 }')
  echo "published: sequence $PUBLISHED_SEQ ($PUBLISHED_DIGEST)"
  if [ "$LOCAL_SEQ" -eq "$PUBLISHED_SEQ" ]; then
    if cmp -s "$WORK/list-dir/method-list.json" "$WORK/published/method-list.json"; then
      echo "already published: sequence $LOCAL_SEQ is $REF:$LINE"
      exit 0
    fi
    die "sequence $LOCAL_SEQ is published with OTHER bytes: assemble a new list (sequence $((LOCAL_SEQ + 1)))"
  fi
  [ "$LOCAL_SEQ" -gt "$PUBLISHED_SEQ" ] || die "sequence $LOCAL_SEQ is superseded by the published #$PUBLISHED_SEQ"
  "$REPO/scripts/check-method-list.sh" --list-dir "$WORK/list-dir" --previous "$WORK/published/method-list.json" \
    || die "the list does not keep the published list's rows and facts"
fi

# ── d. every pinned layer and base resolves to its digest ──────────────────────
echo "== d. pins"
python3 - "$WORK/list-dir/method-env-images.json" > "$WORK/pins.txt" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
for e in doc.get("bases") or []:
    print(e["oci_ref"], e["tag"], e["digest"])
for e in doc["envs"]:
    print(e["oci_ref"], e["tag"], e["digest"])
PY
n_pins=0
while read -r oci_ref tag digest; do
  got=$(oras_anon resolve "$(target "$oci_ref"):$tag" 2>/dev/null || true)
  [ "$got" = "$digest" ] || die "pin $oci_ref:$tag resolves to '${got:-nothing}', the list pins $digest: publish the layer or base first"
  n_pins=$((n_pins + 1))
done < "$WORK/pins.txt"
echo "$n_pins pins resolve to their digests"

COMMENT="txresbench-method-list format=$FORMAT_VERSION sequence=$LOCAL_SEQ"
if [ "$DRY_RUN" = 1 ]; then
  echo "== dry run: nothing is signed or pushed. Next:"
  echo "+ env -i PATH=… HOME=… minisign -S -s $KEY -m method-list.json -t '$COMMENT'"
  echo "+ minisign -V -H -P <the signer's key from data/method-list/trusted-keys.json>; txresbench check-method-list"
  echo "+ oras push --registry-config <temp, mode 600> $REF:$TAG --artifact-type $ARTIFACT_TYPE" \
       "--annotation org.opencontainers.image.source=$SOURCE_URL" \
       "--annotation org.opencontainers.image.revision=$METHODS_COMMIT method-list.json method-list.json.minisig"
  echo "+ oras resolve $REF:$LINE   # must still be ${PUBLISHED_DIGEST:-absent}"
  echo "+ oras tag $REF@<pushed digest> $LINE"
  echo "+ oras pull $REF:$LINE   # byte-compare both files"
  exit 0
fi

# ── e. sign, scrubbed ───────────────────────────────────────────────────────────
echo "== e. sign"
[ -f "$KEY" ] || usage_error "no minisign secret key at $KEY (--key)"
mode=$(stat -c '%a' "$KEY" 2>/dev/null || stat -f '%Lp' "$KEY")
[ $((8#$mode & 8#077)) -eq 0 ] || die "$KEY is readable by others (mode $mode): chmod 600 it"
cp "$WORK/list-dir/method-list.json" "$WORK/out/method-list.json"
env -i PATH="$PATH" HOME="${HOME:-/}" minisign -S -s "$KEY" -m "$WORK/out/method-list.json" \
  -x "$WORK/out/method-list.json.minisig" -t "$COMMENT" -c "txresbench-method-list sequence $LOCAL_SEQ" \
  || die "minisign refused to sign"

# ── f. verify ────────────────────────────────────────────────────────────────────
echo "== f. verify"
TRUSTED="${KEYS_FILE:-$REPO/data/method-list/trusted-keys.json}"
signer_key=$(python3 - "$WORK/out/method-list.json.minisig" "$TRUSTED" <<'PY'
import base64, json, sys
line = open(sys.argv[1]).read().splitlines()[1]
kid = base64.b64decode(line)[2:10][::-1].hex().upper()
for k in json.load(open(sys.argv[2]))["keys"]:
    if k["key_id"] == kid:
        print(k["public_key"])
        sys.exit(0)
print(f"publish-method-list: the signing key {kid} is not in {sys.argv[2]}: the app would refuse this list", file=sys.stderr)
sys.exit(1)
PY
) || exit 1
minisign -V -H -q -P "$signer_key" -m "$WORK/out/method-list.json" -x "$WORK/out/method-list.json.minisig" \
  || die "minisign -V refused the new signature"
report=$(cli check-method-list --list "$WORK/out/method-list.json" --signature "$WORK/out/method-list.json.minisig" \
  ${cli_keys[@]+"${cli_keys[@]}"}) || die "the app's verifier refused the signed list"
printf '%s\n' "$report" | grep -qx "sequence: $LOCAL_SEQ" || die "the app's verifier read another sequence"
printf '%s\n' "$report"

# ── g. push the immutable tag ───────────────────────────────────────────────────
echo "== g. push $REF:$TAG"
if [ -n "$LOOPBACK" ]; then
  PUSH_CONFIG="$EMPTY_CONFIG"
else
  [ -n "${GHCR_USER:-}" ] && [ -n "${GHCR_TOKEN:-}" ] || usage_error "set GHCR_USER and GHCR_TOKEN (a classic token with write:packages)"
  PUSH_CONFIG="$WORK/auth/registry-config.json"
  (umask 077 && GHCR_AUTH="$GHCR_USER:$GHCR_TOKEN" python3 -c '
import base64, json, os, sys
auth = base64.b64encode(os.environ["GHCR_AUTH"].encode()).decode()
json.dump({"auths": {"ghcr.io": {"auth": auth}}}, open(sys.argv[1], "w"))' "$PUSH_CONFIG")
fi
oras_auth() { local sub=$1; shift; oras "$sub" --registry-config "$PUSH_CONFIG" ${plain[@]+"${plain[@]}"} "$@"; }
# With the token: a package's first push creates it PRIVATE, and a rerun must still see it.
existing=$(oras_auth resolve "$REF:$TAG" 2>/dev/null || true)
if [ -n "$existing" ]; then
  # A run that stopped after its push: the same list and signature are the same artifact.
  rm -rf "$WORK/existing" && mkdir -p "$WORK/existing"
  oras_auth pull "$REF@$existing" -o "$WORK/existing" >/dev/null || die "cannot pull the existing $REF:$TAG"
  for f in method-list.json method-list.json.minisig; do
    cmp -s "$WORK/existing/$f" "$WORK/out/$f" || die "$REF:$TAG already exists with other bytes ($f): immutable tags are never overwritten"
  done
  PUSHED="$existing"
  echo "$REF:$TAG already holds these bytes ($existing): not pushed again"
else
  (cd "$WORK/out" && oras_auth push --artifact-type "$ARTIFACT_TYPE" \
    --annotation "org.opencontainers.image.source=$SOURCE_URL" \
    --annotation "org.opencontainers.image.revision=$METHODS_COMMIT" \
    "$REF:$TAG" "method-list.json:$LIST_MEDIA" "method-list.json.minisig:$SIG_MEDIA" >/dev/null) \
    || die "oras push failed"
  PUSHED=$(oras_auth resolve "$REF:$TAG") || die "the pushed $REF:$TAG does not resolve"
  echo "pushed $REF:$TAG = $PUSHED"
fi
# Installed apps read anonymously: so must this run, before v1 points anywhere.
anon=$(oras_anon resolve "$REF:$TAG" 2>/dev/null || true)
[ "$anon" = "$PUSHED" ] || die "$REF:$TAG is pushed but not readable anonymously. A new package starts private: make it public (GitHub: the package's settings, Change visibility), then rerun with the same arguments; the rerun finds this push and only moves $LINE"

# ── h. move v1, unless it moved meanwhile ───────────────────────────────────────
echo "== h. $REF:$LINE"
now=$(oras_anon resolve "$REF:$LINE" 2>/dev/null || true)
if [ "$now" != "$PUBLISHED_DIGEST" ]; then
  other="unknown"
  if [ -n "$now" ]; then
    rm -rf "$WORK/moved" && mkdir -p "$WORK/moved"
    oras_anon pull "$REF@$now" -o "$WORK/moved" >/dev/null 2>&1 && other=$(field "$WORK/moved/method-list.json" sequence 2>/dev/null || echo unknown)
  fi
  die "$REF:$LINE moved while this ran: it was #${PUBLISHED_SEQ:-none} (${PUBLISHED_DIGEST:-absent}), it is now #$other (${now:-absent}). This list (#$LOCAL_SEQ) is at $REF:$TAG and $LINE was NOT moved: check which list is newest, then rerun"
fi
oras_auth tag "$REF@$PUSHED" "$LINE" >/dev/null || die "oras tag failed: $REF:$TAG is pushed, $LINE was not moved"

# ── i. read it back ──────────────────────────────────────────────────────────────
echo "== i. read back"
oras_anon pull "$REF:$LINE" -o "$WORK/check" >/dev/null || die "cannot pull $REF:$LINE back"
for f in method-list.json method-list.json.minisig; do
  if ! cmp -s "$WORK/check/$f" "$WORK/out/$f"; then
    echo "publish-method-list: !!! POST-PUSH MISMATCH: $REF:$LINE serves another $f than the one just signed." >&2
    echo "publish-method-list: !!! Installed apps will refuse or miss this list. Investigate before anything else." >&2
    exit 1
  fi
done
python3 "$REPO/scripts/assemble-method-list.py" --diff \
  "$( [ -n "$PUBLISHED_DIGEST" ] && echo "$WORK/published/method-list.json" || echo - )" "$WORK/out/method-list.json"
echo "published: $REF:$TAG = $REF:$LINE ($PUSHED), sequence $LOCAL_SEQ, methods ${METHODS_COMMIT:0:12}"
