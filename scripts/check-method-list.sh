#!/usr/bin/env bash
#
# check-method-list.sh — the guard of the signed method list (method-list.json).
#
# ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────
# The method list carries both halves of the method facts the app runs on (the catalogue
# and the environment images list), nested, under a header with a sequence; a maintainer
# signs it and publishes it, and an app release imports it as its built-in copy. Its DATA
# lives in the methods repository (method-list/); the tools that write it live here. This
# guard re-checks, from the outside, what the writer (scripts/assemble-method-list.py)
# produced, in two places:
#
#   METHODS MODE (--list-dir <methods>/method-list [--previous <list>]): the check a
#   maintainer runs before asking for the methods-repository PR to be merged, and that the
#   publisher re-runs against the methods repository's origin/main.
#     1. the header: the committed schema (data/method-list/method-list.schema.json) —
#        format, format_version 1, sequence >= 1 (0 is the app's unsigned bootstrap copy
#        only), assembled_at, the two documents, NO other field;
#     2. the nested documents equal the two source files beside it (parsed);
#     3. the cross rules: (1) every image entry has a catalogue row; (2) every image
#        entry carries its row's version; with --previous also (3) no row of the previous
#        list is removed (a retired method keeps its row with runnable: false), (5) a
#        run-shaping fact changes only with a version bump, and the sequence is above the
#        previous one;
#     4. parity: the list is exactly the writer's assembly of the two files with its own
#        header (`assemble-method-list.py --check`): no hand edit;
#     5. size: at most 16 MiB (the cap the app enforces).
#
#   APP MODE (the default; the gate runs it on this tree):
#     1. data/method-list/trusted-keys.json is a trusted-keys file whose ids are the keys'
#        own, and it does NOT hold the fixture key (scripts/method-list/fixtures/
#        test-key.pub), whose secret half is committed with the fixtures;
#     2. when the app carries an imported list (data/method-list/method-list.json): its
#        header and size as above (sequence >= 0); the app's two extracted copies
#        (data/method-catalogue/catalogue.json, src-app/server/data/method-env-images.json)
#        equal its nested documents; method-list.json.minisig is present exactly when the
#        sequence is >= 1, its trusted comment names this list's format and sequence and
#        its key id is a trusted key (the signature itself is checked by the app's own
#        verifier: `txresbench check-method-list`); cross rules (1) and (2).
#        Until the first import there is no list: the guard says so and checks the keys only.
#
# ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────────
# No signature cryptography (the Rust verifier is the arbiter), no network, no write. The
# nested documents' own rules are their own guards' (check-method-env-images.sh for the
# images list; the catalogue's loader and hygiene tests).
#
# ── USAGE ─────────────────────────────────────────────────────────────────────
#   scripts/check-method-list.sh                                    # app mode, this tree
#   scripts/check-method-list.sh --app-dir DIR                      # app mode, another tree
#   scripts/check-method-list.sh --list-dir <methods>/method-list [--previous LIST]
#
# Exit 0 = valid. 1 = a rule failed (named). 2 = usage / missing input.
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SCHEMA="$REPO/data/method-list/method-list.schema.json"
ASSEMBLER="$REPO/scripts/assemble-method-list.py"
APP_DIR="$REPO"
LIST_DIR=""
PREVIOUS=""

usage() { awk 'NR > 1 && /^# ── USAGE/ { on = 1; next } on && /^# Exit/ { exit } on { sub(/^# ?/, ""); print }' "$0"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --list-dir) shift; [ $# -gt 0 ] || { echo "check-method-list: --list-dir needs a value" >&2; exit 2; }; LIST_DIR="$1" ;;
    --list-dir=*) LIST_DIR="${1#--list-dir=}" ;;
    --previous) shift; [ $# -gt 0 ] || { echo "check-method-list: --previous needs a value" >&2; exit 2; }; PREVIOUS="$1" ;;
    --previous=*) PREVIOUS="${1#--previous=}" ;;
    --app-dir) shift; [ $# -gt 0 ] || { echo "check-method-list: --app-dir needs a value" >&2; exit 2; }; APP_DIR="$1" ;;
    --app-dir=*) APP_DIR="${1#--app-dir=}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "check-method-list: unknown argument '$1'" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

[ -f "$SCHEMA" ] || { echo "check-method-list: schema not found: $SCHEMA" >&2; exit 2; }
if [ -n "$LIST_DIR" ]; then
  for f in method-list.json catalogue.json method-env-images.json; do
    [ -f "$LIST_DIR/$f" ] || { echo "check-method-list: $LIST_DIR/$f not found" >&2; exit 2; }
  done
  [ -z "$PREVIOUS" ] || [ -f "$PREVIOUS" ] || { echo "check-method-list: previous list not found: $PREVIOUS" >&2; exit 2; }
  MODE=methods
else
  [ -z "$PREVIOUS" ] || { echo "check-method-list: --previous goes with --list-dir" >&2; exit 2; }
  [ -d "$APP_DIR" ] || { echo "check-method-list: app dir not found: $APP_DIR" >&2; exit 2; }
  MODE=app
fi

python3 - "$MODE" "$SCHEMA" "$LIST_DIR" "$PREVIOUS" "$APP_DIR" <<'PYEOF' || exit $?
import base64
import json
import os
import re
import sys

mode, schema_path, list_dir, previous_path, app_dir = sys.argv[1:6]
MAX_LIST_BYTES = 16 * 1024 * 1024
FACTS = ("markers", "required_markers", "covariates", "min_draws", "needs_baseline",
         "uses_history", "fitted", "saves_model", "own_outputs", "tasks", "group",
         "needs_detection_call", "params")


def fail(msg):
    print(f"check-method-list: FAIL: {msg}", file=sys.stderr)
    sys.exit(1)


def no_dup(pairs):
    out = {}
    for k, v in pairs:
        if k in out:
            raise ValueError(f"duplicate key {k!r}")
        out[k] = v
    return out


def load(path, what):
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except OSError as e:
        fail(f"{what} {path}: {e}")
    if what == "list" and len(raw) > MAX_LIST_BYTES:
        fail(f"LIST_TOO_LARGE: {path} is {len(raw)} bytes, over the {MAX_LIST_BYTES}-byte cap")
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=no_dup)
    except ValueError as e:
        fail(f"{what} {path} is not valid JSON: {e}")


# ── the header schema: a subset validator that refuses any keyword it does not implement
with open(schema_path, encoding="utf-8") as f:
    schema = json.load(f)
META = {"$schema", "$id", "title", "description"}
KEYWORDS = {"type", "const", "minimum", "pattern", "required", "properties", "additionalProperties"}
for k in schema:
    if k not in META | KEYWORDS:
        fail(f"schema keyword {k!r} is not implemented here: refuse rather than under-validate")
for name, sub in schema.get("properties", {}).items():
    for k in sub:
        if k not in META | KEYWORDS - {"properties", "required", "additionalProperties"}:
            fail(f"schema keyword {k!r} (property {name}) is not implemented here")
TYPES = {"string": lambda v: isinstance(v, str),
         "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
         "object": lambda v: isinstance(v, dict)}


def check_header(doc, path, min_sequence):
    if not isinstance(doc, dict):
        fail(f"{path}: not a JSON object")
    missing = [k for k in schema["required"] if k not in doc]
    if missing:
        fail(f"{path}: header field(s) missing: {', '.join(missing)}")
    if schema.get("additionalProperties") is False:
        extra = sorted(set(doc) - set(schema["properties"]))
        if extra:
            fail(f"{path}: unknown header field(s) {', '.join(extra)} (a header change is a new "
                 "format_version)")
    for name, sub in schema["properties"].items():
        v = doc[name]
        if not TYPES[sub["type"]](v):
            fail(f"{path}: {name} must be a {sub['type']}, got {v!r:.80}")
        if "const" in sub and v != sub["const"]:
            fail(f"{path}: {name} is {v!r}, must be {sub['const']!r}")
        if "minimum" in sub and v < sub["minimum"]:
            fail(f"{path}: {name} {v} < {sub['minimum']}")
        if "pattern" in sub and not re.search(sub["pattern"], v):
            fail(f"{path}: {name} {v!r} does not match {sub['pattern']}")
    if doc["sequence"] < min_sequence:
        fail(f"{path}: sequence {doc['sequence']} is below {min_sequence} (sequence 0 is the "
             "app's unsigned bootstrap copy only)")


def check_rules(doc, path, previous=None):
    cat, img = doc["catalogue"], doc["images"]
    methods = cat.get("methods")
    envs = img.get("envs")
    if not isinstance(methods, list) or not all(isinstance(m, dict) and "id" in m for m in methods):
        fail(f"{path}: catalogue.methods is not a list of rows with an id")
    if not isinstance(envs, list) or not all(isinstance(e, dict) for e in envs):
        fail(f"{path}: images.envs is not a list of entries")
    rows = {m["id"]: m for m in methods}
    for e in envs:
        ref = f"{e.get('env_id')}-{e.get('arch')}"
        row = rows.get(e.get("method_id"))
        if row is None:
            fail(f"LIST_UNKNOWN_METHOD: {path}: image entry {ref} has no catalogue row "
                 f"{e.get('method_id')!r} (rule 1)")
        if not same(e.get("method_version"), row.get("version")):
            fail(f"LIST_VERSION_MISMATCH: {path}: image entry {ref} is version "
                 f"{e.get('method_version')!r}, its row {row.get('version')!r} (rule 2)")
    if previous is None:
        return
    if doc["sequence"] <= previous["sequence"]:
        fail(f"{path}: sequence {doc['sequence']} is not above the previous list's "
             f"{previous['sequence']}")
    for old in previous["catalogue"].get("methods") or []:
        new = rows.get(old.get("id"))
        if new is None:
            fail(f"LIST_ROW_REMOVED: {path}: method {old.get('id')!r} of the previous list is "
                 "missing (rule 3: retire it with runnable: false)")
        if same(new.get("version"), old.get("version")):
            changed = [f for f in FACTS if not same(new.get(f), old.get(f))]
            if changed:
                fail(f"LIST_FACTS_CHANGED_SAME_VERSION: {path}: method {old.get('id')!r} keeps "
                     f"version {old.get('version')!r} but changes {', '.join(changed)} (rule 5)")


def same(a, b):
    """Equal as JSON, types included: Python's == takes 1 == 1.0 == True."""
    return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


def counts(doc):
    return (f"sequence {doc['sequence']}, {len(doc['catalogue']['methods'])} methods, "
            f"{len(doc['images']['envs'])} image entries, "
            f"{len(doc['images'].get('bases') or [])} bases")


if mode == "methods":
    path = os.path.join(list_dir, "method-list.json")
    doc = load(path, "list")
    check_header(doc, path, 1)
    for field, name in (("catalogue", "catalogue.json"), ("images", "method-env-images.json")):
        src = os.path.join(list_dir, name)
        if not same(load(src, "document"), doc[field]):
            fail(f"{path}: the nested {field} is not {src} (re-run the assembler)")
    previous = None
    if previous_path:
        previous = load(previous_path, "list")
        check_header(previous, previous_path, 0)
    check_rules(doc, path, previous)
    print(f"check-method-list: OK — {path}: header, nested documents, cross rules"
          f"{' against ' + previous_path if previous_path else ''} ({counts(doc)})")
    sys.exit(0)

# ── app mode
keys_path = os.path.join(app_dir, "data/method-list/trusted-keys.json")
fixture_pub = os.path.join(app_dir, "scripts/method-list/fixtures/test-key.pub")
keys = load(keys_path, "trusted-keys file")
if not (isinstance(keys, dict) and keys.get("format") == "txresbench-method-list-keys"
        and keys.get("format_version") == 1 and isinstance(keys.get("keys"), list)
        and set(keys) == {"format", "format_version", "keys"}):
    fail(f"{keys_path} is not a txresbench-method-list-keys version 1 file")


def key_id_of(b64, where):
    try:
        raw = base64.b64decode(b64.strip(), validate=True)
    except (ValueError, AttributeError):
        fail(f"{where}: the public key is not base64")
    if len(raw) != 42 or raw[:2] != b"Ed":
        fail(f"{where}: not a minisign Ed25519 public key")
    return raw[2:10][::-1].hex().upper()


trusted = {}
for i, k in enumerate(keys["keys"]):
    where = f"{keys_path} keys[{i}]"
    if not isinstance(k, dict) or set(k) != {"label", "key_id", "public_key"}:
        fail(f"{where}: a key is exactly {{label, key_id, public_key}}")
    if not isinstance(k["label"], str) or not k["label"].strip():
        fail(f"{where}: empty label")
    kid = key_id_of(k["public_key"], where)
    if k["key_id"] != kid:
        fail(f"{where}: key_id {k['key_id']!r} is not the key's own id {kid}")
    if kid in trusted:
        fail(f"{where}: key id {kid} is listed twice")
    trusted[kid] = k
try:
    fixture_lines = open(fixture_pub, encoding="utf-8").read().splitlines()
except OSError as e:
    fail(f"the fixture key {fixture_pub} is needed to prove it is not trusted: {e}")
fixture_id = key_id_of(fixture_lines[1] if len(fixture_lines) > 1 else "", fixture_pub)
if fixture_id in trusted or any(k["public_key"].strip() == fixture_lines[1].strip()
                                for k in trusted.values()):
    fail(f"{keys_path} trusts the FIXTURE key {fixture_id}: its secret key is committed with the "
         "test fixtures, so anyone could sign a list the app accepts")

list_path = os.path.join(app_dir, "data/method-list/method-list.json")
sig_path = list_path + ".minisig"
if not os.path.exists(list_path):
    if os.path.exists(sig_path):
        fail(f"{sig_path} without {list_path}")
    print(f"check-method-list: OK — trusted keys ({len(trusted)}; the fixture key is not one). "
          f"No imported list yet ({os.path.relpath(list_path, app_dir)}): the list checks start "
          "with the first import (scripts/import-method-list.sh)")
    sys.exit(0)

doc = load(list_path, "list")
check_header(doc, list_path, 0)
for field, rel in (("catalogue", "data/method-catalogue/catalogue.json"),
                   ("images", "src-app/server/data/method-env-images.json")):
    if not same(load(os.path.join(app_dir, rel), "document"), doc[field]):
        fail(f"{rel} is not the {field} of {os.path.relpath(list_path, app_dir)}: the app's copies "
             "are written by scripts/import-method-list.sh, never by hand")
check_rules(doc, list_path)
has_sig = os.path.exists(sig_path)
if doc["sequence"] == 0 and has_sig:
    fail(f"{sig_path} exists, but sequence 0 is the unsigned bootstrap copy")
if doc["sequence"] >= 1:
    if not has_sig:
        fail(f"{list_path} is sequence {doc['sequence']} and has no {os.path.basename(sig_path)}: "
             "a published list is imported with its signature")
    lines = open(sig_path, encoding="utf-8", errors="replace").read().splitlines()
    want = f"trusted comment: txresbench-method-list format={doc['format_version']} sequence={doc['sequence']}"
    if len(lines) < 4 or lines[2] != want:
        fail(f"{sig_path}: the trusted comment is not {want!r}")
    try:
        raw = base64.b64decode(lines[1].strip(), validate=True)
    except ValueError:
        fail(f"{sig_path}: the signature line is not base64")
    if len(raw) != 74 or raw[:2] != b"ED":
        fail(f"{sig_path}: not a prehashed minisign signature")
    sid = raw[2:10][::-1].hex().upper()
    if sid not in trusted:
        fail(f"{sig_path}: signed by key {sid}, which is not in {keys_path}")
print(f"check-method-list: OK — trusted keys ({len(trusted)}; the fixture key is not one); "
      f"{os.path.relpath(list_path, app_dir)}: header, the app's copies, signature presence, cross "
      f"rules ({counts(doc)})")
PYEOF

# ── methods mode: parity with the writer (no hand edit)
if [ "$MODE" = methods ]; then
  prev_args=()
  [ -z "$PREVIOUS" ] || prev_args=(--previous "$PREVIOUS")
  python3 "$ASSEMBLER" --list-dir "$LIST_DIR" --check ${prev_args[@]+"${prev_args[@]}"} || {
    echo "check-method-list: FAIL: parity — $LIST_DIR/method-list.json is not the writer's assembly" >&2
    exit 1
  }
fi
exit 0
