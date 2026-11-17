#!/usr/bin/env bash
#
# import-method-list.sh — make the published method list this app release's built-in copy.
#
# Run at an app release (no token, no key): anonymously pull
# ghcr.io/tinnlab/txresbench-method-list:v1 (or :v1-seq-<N> with --sequence N), verify it with
# the app's own verifier and trusted keys (`txresbench check-method-list`), refuse a sequence
# below the current built-in copy or a list that drops a row of it (or changes a fact at the
# same version; before the first import, of the app's current two documents), then write
#   data/method-list/method-list.json + method-list.json.minisig
# and extract the two nested documents to the paths the app and its tools read today, with
# each generator's own writer:
#   data/method-catalogue/catalogue.json          (gen_method_catalogue.py)
#   src-app/server/data/method-env-images.json    (generate-method-env-images.py)
# Those two files are imported copies: never edit them here; change the list in the methods
# repository and publish a new one. The import PR also updates the app tests that pin
# counts of the shipped data: a pin that moves is what the release review should see.
#
# --bootstrap (until the first publish only): a sequence 0 list from the app's current two
# files, without a signature (the app accepts an unsigned list only at sequence 0).
#
# Usage:
#   scripts/import-method-list.sh [--sequence N] [--cli <txresbench binary>]
#   scripts/import-method-list.sh --bootstrap
#   --registry 127.0.0.1:<port>  pull from a loopback rehearsal registry (plain HTTP)
#   --app-dir DIR                write into another app tree (tests); default: this checkout
#   --keys FILE                  verify with another trusted-keys file; only with an --app-dir
#                                that is not this checkout (the seam never writes here)
#   --cli PATH                   the txresbench binary to verify with; default: `cargo run` in
#                                this checkout (a TXR_CLI in the environment is refused: name
#                                the verifier with --cli)
#
# Exit: 0 imported (or already current); 1 a refusal; 2 usage or tooling.
set -euo pipefail

REPO=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
PACKAGE="ghcr.io/tinnlab/txresbench-method-list"
LINE="v1"

APP_DIR="$REPO"
SEQUENCE=""
BOOTSTRAP=0
LOOPBACK=""
KEYS_FILE=""
CLI=""

usage() { awk 'NR == 1 { next } /^[^#]/ { exit } { sub(/^# ?/, ""); print }' "$0"; }
die() { echo "import-method-list: $*" >&2; exit 1; }
usage_error() { echo "import-method-list: $*" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --sequence) SEQUENCE=${2-}; shift 2 ;;
    --bootstrap) BOOTSTRAP=1; shift ;;
    --registry) LOOPBACK=${2-}; shift 2 ;;
    --app-dir) APP_DIR=${2-}; shift 2 ;;
    --keys) KEYS_FILE=${2-}; shift 2 ;;
    --cli) CLI=${2-}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage_error "unknown argument: $1" ;;
  esac
done

if [ -z "$CLI" ] && [ -n "${TXR_CLI:-}" ]; then
  usage_error "TXR_CLI is set ($TXR_CLI): the verifier is named only with --cli; pass --cli \"\$TXR_CLI\" to use it, or unset TXR_CLI"
fi
[ -d "$APP_DIR" ] || usage_error "--app-dir $APP_DIR: no such directory"
APP_DIR=$(cd "$APP_DIR" && pwd -P)
if [ -n "$KEYS_FILE" ]; then
  [ "$APP_DIR" != "$(cd "$REPO" && pwd -P)" ] || usage_error "--keys (another trusted-keys file) never writes into this checkout: pass --app-dir <a test tree>"
  [ -f "$KEYS_FILE" ] || usage_error "--keys $KEYS_FILE: no such file"
  KEYS_FILE="$(cd "$(dirname "$KEYS_FILE")" && pwd -P)/$(basename "$KEYS_FILE")"
fi
if [ -n "$SEQUENCE" ]; then
  [[ $SEQUENCE =~ ^[1-9][0-9]{0,5}$ ]] || usage_error "--sequence takes a published sequence number (1-999999)"
fi
if [ -n "$LOOPBACK" ]; then
  loopback_re='^(127\.0\.0\.1|\[::1\]):[0-9]{1,5}$'
  [[ $LOOPBACK =~ $loopback_re ]] || usage_error "--registry must be 127.0.0.1:<port> or [::1]:<port>; got '$LOOPBACK'"
fi
export PYTHONDONTWRITEBYTECODE=1

LIST="$APP_DIR/data/method-list/method-list.json"
SIG="$LIST.minisig"
CATALOGUE="$APP_DIR/data/method-catalogue/catalogue.json"
IMAGES="$APP_DIR/src-app/server/data/method-env-images.json"
ASSEMBLER="$REPO/scripts/assemble-method-list.py"
mkdir -p "$APP_DIR/data/method-list"

# The verifier: --cli, or this checkout's own build. cargo runs IN the checkout so it reads
# the repository's .cargo/config.toml (its [env] build settings); every argument is absolute.
cli() {
  if [ -n "$CLI" ]; then
    "$CLI" "$@"
  else
    (cd "$REPO" && cargo run --quiet --manifest-path "$REPO/src-app/server/Cargo.toml" --bin txresbench -- "$@")
  fi
}
echo "import-method-list: verifier: ${CLI:-cargo run (this checkout, $REPO)}"
cli_keys=()
[ -z "$KEYS_FILE" ] || cli_keys=(--keys "$KEYS_FILE")

WORK=$(mktemp -d "${TMPDIR:-/tmp}/import-method-list.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

current_seq=""
if [ -f "$LIST" ]; then
  current_seq=$(python3 "$ASSEMBLER" --sequence-of "$LIST") || die "the current $LIST is not a method list"
  cp "$LIST" "$WORK/old-list.json"
fi

# ── --bootstrap ─────────────────────────────────────────────────────────────────
if [ "$BOOTSTRAP" = 1 ]; then
  [ -z "$SEQUENCE" ] && [ -z "$LOOPBACK" ] || usage_error "--bootstrap reads the app's own files: no --sequence, no --registry"
  if [ -n "$current_seq" ] && [ "$current_seq" -ge 1 ]; then
    die "the app carries published list #$current_seq: --bootstrap is for before the first publish only"
  fi
  [ ! -f "$SIG" ] || die "$SIG exists, but a bootstrap list has no signature"
  python3 "$ASSEMBLER" --bootstrap --catalogue "$CATALOGUE" --images "$IMAGES" --out "$WORK/method-list.json" >/dev/null
  cli check-method-list --list "$WORK/method-list.json" >/dev/null || die "the app's loader refused the bootstrap list"
  python3 "$ASSEMBLER" --extract "$WORK/method-list.json" --catalogue-out "$WORK/catalogue.json" --images-out "$WORK/images.json" >/dev/null
  cmp -s "$WORK/catalogue.json" "$CATALOGUE" && cmp -s "$WORK/images.json" "$IMAGES" \
    || die "the app's two files are not in their generators' layout; regenerate them before a bootstrap"
  mv "$WORK/method-list.json" "$LIST"
  echo "import-method-list: wrote ${LIST#"$APP_DIR"/}: sequence 0 (bootstrap, unsigned) from the app's current files"
  exit 0
fi

# ── pull ────────────────────────────────────────────────────────────────────────
command -v oras >/dev/null 2>&1 || usage_error "oras not found"
ref="$PACKAGE:$LINE"
[ -z "$SEQUENCE" ] || ref="$PACKAGE:$LINE-seq-$(printf '%06d' "$SEQUENCE")"
plain=()
if [ -n "$LOOPBACK" ]; then
  ref="$LOOPBACK/${ref#ghcr.io/}"
  plain=(--plain-http)
fi
printf '{}' > "$WORK/registry-config.json"
# Anonymous: the empty registry config, so no Docker login or credential helper is read.
oras pull --registry-config "$WORK/registry-config.json" ${plain[@]+"${plain[@]}"} "$ref" -o "$WORK/pull" >/dev/null \
  || die "cannot pull $ref"
[ "$(ls -A "$WORK/pull" | sort | tr '\n' ' ')" = "method-list.json method-list.json.minisig " ] \
  || die "$ref is not exactly method-list.json + method-list.json.minisig"
for f in method-list.json method-list.json.minisig; do
  [ -f "$WORK/pull/$f" ] && [ ! -L "$WORK/pull/$f" ] || die "$ref: $f is not a regular file"
done

# ── verify with the app's own verifier ─────────────────────────────────────────
report=$(cli check-method-list --list "$WORK/pull/method-list.json" --signature "$WORK/pull/method-list.json.minisig" \
  ${cli_keys[@]+"${cli_keys[@]}"}) || die "$ref does not verify with the app's trusted keys: not imported"
new_seq=$(printf '%s\n' "$report" | awk -F': ' '$1 == "sequence" { print $2 }')
[[ $new_seq =~ ^[0-9]+$ ]] || die "the verifier reported no sequence"
[ -z "$SEQUENCE" ] || [ "$new_seq" = "$SEQUENCE" ] || die "$ref holds sequence $new_seq, not $SEQUENCE"
if [ -n "$current_seq" ]; then
  if [ "$new_seq" -lt "$current_seq" ]; then
    die "$ref is sequence $new_seq, below the built-in #$current_seq: never import an older list"
  fi
  if [ "$new_seq" -eq "$current_seq" ]; then
    if cmp -s "$WORK/pull/method-list.json" "$LIST"; then
      echo "import-method-list: the built-in list is already #$current_seq"
      exit 0
    fi
    die "$ref is sequence $new_seq, the built-in #$current_seq holds OTHER bytes: refusing"
  fi
  # A list never drops a row or changes a fact at the same version (rules 3 and 5): the
  # publisher checks this against the published list, the import against what it replaces.
  python3 "$ASSEMBLER" --successor "$LIST" "$WORK/pull/method-list.json" >/dev/null \
    || die "$ref does not keep the rows and facts of the built-in #$current_seq"
else
  # No built-in list yet: what the import replaces is the app's current two documents.
  python3 "$ASSEMBLER" --bootstrap --catalogue "$CATALOGUE" --images "$IMAGES" \
    --out "$WORK/old-list.json" >/dev/null 2>"$WORK/current.err" \
    || { cat "$WORK/current.err" >&2; die "the app's current documents are not a method list's ($CATALOGUE, $IMAGES): nothing to compare the new list with"; }
  python3 "$ASSEMBLER" --successor "$WORK/old-list.json" "$WORK/pull/method-list.json" >/dev/null \
    || die "$ref does not keep the rows and facts of the app's current documents"
fi

# ── write: the list, its signature, the two extracted documents ────────────────
python3 "$ASSEMBLER" --extract "$WORK/pull/method-list.json" \
  --catalogue-out "$WORK/catalogue.json" --images-out "$WORK/images.json" >/dev/null \
  || die "cannot extract the nested documents"
mkdir -p "$(dirname "$CATALOGUE")" "$(dirname "$IMAGES")"
for pair in "pull/method-list.json:$LIST" "pull/method-list.json.minisig:$SIG" \
            "catalogue.json:$CATALOGUE" "images.json:$IMAGES"; do
  src="$WORK/${pair%%:*}"
  dst="${pair#*:}"
  cp "$src" "$dst.import-tmp"
  mv "$dst.import-tmp" "$dst"
done
printf '%s\n' "$report"
python3 "$ASSEMBLER" --diff "$( [ -f "$WORK/old-list.json" ] && echo "$WORK/old-list.json" || echo - )" "$LIST"
echo "import-method-list: imported #$new_seq into ${APP_DIR}: data/method-list/, data/method-catalogue/catalogue.json, src-app/server/data/method-env-images.json"
echo "import-method-list: next: update the app tests that pin counts of the shipped data, run the gate, open the import PR"
