#!/usr/bin/env bash
#
# check-method-env-images.sh — validate the committed per-method environment
# manifest and its regen parity (plan node method-env-images, ITEM-4).
#
# ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────
# `src-app/server/data/method-env-images.json` is GENERATED (INV-5): the runtime
# fetches layers by its `digest`, the download rows show its `size_bytes` before
# the transfer starts (DEC-7), and a saved model records its values verbatim
# (INV-6). A hand-edit of one of those fields is a silent divergence from the
# artifact the clinician actually runs — exactly the category of drift the
# env-pins precedent (`scripts/check-recipe-pins.mjs`) guards against, applied
# to the one generated file this node ships. This guard is the committed-file
# validator: it re-validates what the writer (ITEM-3) assembled, from the
# outside, so a bad record that produced a bad manifest is caught HERE rather
# than at a clinician's first run.
#
# ── WHAT IT CHECKS ─────────────────────────────────────────────────────────────
#   1. SCHEMA CONFORMANCE — the manifest validates against
#      `method-env-images.schema.json`. The validator is a stdlib-only subset
#      validator that implements EXACTLY the keywords that schema uses (type,
#      const, enum, pattern, required, properties, additionalProperties,
#      definitions, $ref, items, minimum, minLength, uniqueItems) and REFUSES
#      any keyword outside the set: a future schema bump that adds `oneOf` or
#      `format` fails closed here instead of silently under-validating. The
#      schema's `additionalProperties: false` is therefore live — an unknown
#      field is refused, not ignored.
#   2. STRUCTURAL RULES the schema cannot spell — the plan's ITEM-4 list plus
#      the DEC rules the writer enforces:
#        - `env_id` grammar per `modules/sandbox/env_id.rs::is_valid_env_id`
#          (`^[a-z0-9._-]+$`, non-empty) AND `env_id == method_id` (DEC-1);
#        - digest/sha256 shapes (`sha256:<64 hex>` for `digest`/`base_digest`,
#          bare 64-hex for `layer_sha256`/`wrapper_code_sha256`), `size_bytes`
#          a positive integer, `arch` ∈ {amd64, arm64} (DEC-10);
#        - `base_ref` = `ghcr.io/tinnlab/txresbench-base-(r|py):<X.Y>` — the
#          benchmark base the delta was computed against — with the key
#          CONSISTENT with `language` (r ↔ R, py ↔ Python) and its tag equal to
#          the entry's `contract`;
#        - `oci_ref` = `ghcr.io/tinnlab/txr-method-env-layers/<env_id>`
#          (DEC-2's namespace, scheme-less per DEC-17 — no new allowlist host);
#        - `tag` = `<method_version>-<arch>` (DEC-2), `layer_schema` == 1
#          (DEC-11), `contract` == the manifest's `base_contract`;
#        - no duplicate (env_id, arch) — the per-arch entry key (PROV-1: one
#          entry per method per published arch; amd64 + arm64 of one method is
#          legal, so the plan's "no duplicate env_id" is enforced as the
#          (env_id, arch) pair, see PLAN note o);
#        - entries strictly sorted by (env_id, arch) (DEC-15's byte
#          determinism is only reachable from a deterministic order);
#        - zero entries ARE accepted (the ITEM-1 seed manifest `envs: []` is
#          the committed state until ITEM-6's regeneration — PLAN note e).
#   3. NO PLACEHOLDER TEXT (INV-2: a published file carries data only). Every
#      STRING value is scanned for status/placeholder vocabulary (TODO, TBD,
#      FIXME, XXX, PLACEHOLDER, STUB, LOREM, TKTK, NOT YET, TO BE FILLED, IN
#      PROGRESS, UNDER CONSTRUCTION, case-insensitive). `envs[].licence` is
#      NEVER scanned: TEST-11 pins the verbatim legal fact and the ITEM-1
#      TESTS.md note records that 5 of the 95 runnable licences contain
#      `stud(y|ies)` — a scan mixing licence DATA with a vocabulary rule
#      reddens the guard on provenance it must not alter (owner question,
#      carried).
#   4. REGEN PARITY — the manifest must byte-reassemble from the staged build
#      records. The records (hashes/sizes) are docker build outputs that no
#      committed file can re-derive, so this leg is a PUBLISHER-MACHINE check
#      (PLAN note n): it runs `generate-method-env-images.py --check` against
#      the staging dir when one is provided (`--staging-dir` / `TXR_ENV_BUILD_DIR`),
#      pinned to the manifest's own `source_revision`. Without a staging dir it
#      SKIPS WITH A REASON (exit 0) — the fixture parity leg of
#      `check-method-env-images.test.mjs` exercises the same code path on every
#      gate run; `--require-parity` turns the absence into a failure.
#      A staging dir + the SEED manifest is red by design (notes e/j: parity is
#      green on the real manifest only after ITEM-6's regeneration).
#
# ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────────
# It does not touch the methods repository (read-only build input), does not
# build, does not push, and does not verify a published artifact behaviorally
# (ITEM-5's publisher assertion + ITEM-7's loopback test do that). It does not
# scan the `licence` field with ANY vocabulary (see check 3).
#
# ── USAGE ─────────────────────────────────────────────────────────────────────
#   scripts/check-method-env-images.sh                          # committed file
#   scripts/check-method-env-images.sh --staging-dir <dir>      # + regen parity
#   scripts/check-method-env-images.sh --manifest FILE --schema FILE
#   scripts/check-method-env-images.sh --staging-dir DIR --methods-dir DIR \
#       --require-parity --verbose
#   TXR_ENV_BUILD_DIR=... scripts/check-method-env-images.sh   # same as --staging-dir
#
# Exit 0 = valid (and parity matched, or skipped with a printed reason).
# 1 = a rule failed (named). 2 = usage / missing file — not a verdict.
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$REPO/src-app/server/data/method-env-images.json"
SCHEMA="$REPO/src-app/server/data/method-env-images.schema.json"
STAGING="${TXR_ENV_BUILD_DIR:-}"
METHODS_DIR="${TXR_METHODS_DIR:-}"
REQUIRE_PARITY=0
VERBOSE=0

usage() {
  cat <<'EOF'
usage: scripts/check-method-env-images.sh [options]
  (no options)       validate the committed manifest + schema, and the regen
                     parity leg from TXR_ENV_BUILD_DIR (or skip with a reason)
  --manifest=FILE    manifest to validate (default src-app/server/data/method-env-images.json)
  --schema=FILE      JSON Schema to validate against (default ...method-env-images.schema.json)
  --staging-dir=DIR  staged build records (TXR_ENV_BUILD_DIR also works) → run regen parity
  --methods-dir=DIR  methods repository for the parity leg (TXR_METHODS_DIR also works)
  --require-parity   make a missing staging dir a failure, not a skip-with-reason
  --verbose          print each validated entry
Exit 0 = valid (and parity matched, or skipped with a printed reason); 1 = a rule
failed (named); 2 = usage / missing file — not a verdict.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --manifest=*) MANIFEST="${1#--manifest=}" ;;
    --manifest) shift; [ $# -gt 0 ] || { echo "check-method-env-images: --manifest needs a value" >&2; exit 2; }; MANIFEST="$1" ;;
    --schema=*) SCHEMA="${1#--schema=}" ;;
    --schema) shift; [ $# -gt 0 ] || { echo "check-method-env-images: --schema needs a value" >&2; exit 2; }; SCHEMA="$1" ;;
    --staging-dir=*) STAGING="${1#--staging-dir=}" ;;
    --staging-dir) shift; [ $# -gt 0 ] || { echo "check-method-env-images: --staging-dir needs a value" >&2; exit 2; }; STAGING="$1" ;;
    --methods-dir=*) METHODS_DIR="${1#--methods-dir=}" ;;
    --methods-dir) shift; [ $# -gt 0 ] || { echo "check-method-env-images: --methods-dir needs a value" >&2; exit 2; }; METHODS_DIR="$1" ;;
    --require-parity) REQUIRE_PARITY=1 ;;
    --verbose) VERBOSE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "check-method-env-images: unknown argument '$1'" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

[ -f "$MANIFEST" ] || { echo "check-method-env-images: manifest not found: $MANIFEST" >&2; exit 2; }
[ -f "$SCHEMA" ] || { echo "check-method-env-images: schema not found: $SCHEMA" >&2; exit 2; }

python3 - "$MANIFEST" "$SCHEMA" "$VERBOSE" <<'PYEOF' || exit $?
import json
import os
import re
import sys

manifest_path, schema_path, verbose = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
fail = lambda msg: (print(f"check-method-env-images: {msg}", file=sys.stderr), sys.exit(1))

with open(manifest_path, encoding="utf-8") as f:
    try:
        manifest = json.load(f)
    except json.JSONDecodeError as e:
        fail(f"{manifest_path} is not valid JSON: {e}")
with open(schema_path, encoding="utf-8") as f:
    schema = json.load(f)

# ── 3. Placeholder scan (BEFORE schema validation deliberately: a placeholder
# value is reported AS a placeholder even when its pattern also fails, so the
# human sees the true problem; see the header's check-3 note). Licence values
# are skipped by path — TEST-11's verbatim legal fact is data, never scanned.
PLACEHOLDER_RE = re.compile(
    r"(?i)\b(TODO|TBD|FIXME|XXX|PLACEHOLDER|STUB|LOREM|TKTK|NOT\s+YET|"
    r"TO\s+BE\s+FILLED|IN\s+PROGRESS|UNDER\s+CONSTRUCTION)\b")

def placeholder_hits(value, path):
    if isinstance(value, str):
        m = PLACEHOLDER_RE.search(value)
        if m:
            yield f"{path}: {m.group(0)!r}"
    elif isinstance(value, dict):
        for k, v in value.items():
            # The licence is TEST-11's verbatim legal fact — data, never a
            # vocabulary scan target (see the header's check-3 note).
            if k == "licence":
                continue
            yield from placeholder_hits(v, f"{path}.{k}")
    elif isinstance(value, list):
        for i, v in enumerate(value):
            yield from placeholder_hits(v, f"{path}[{i}]")

for hit in placeholder_hits(manifest, "manifest"):
    fail(f"status/placeholder text is not data: {hit} "
         "(INV-2: published files carry data only; the licence field is "
         "never scanned — TEST-11)")

# ── 1. Schema conformance. This is a DELIBERATE subset validator: it refuses a
# schema keyword it does not implement, so a schema bump can never silently
# weaken the check (fail closed by construction).
META_KEYS = {"$schema", "$id", "title", "description"}
SUPPORTED_KEYS = {
    "type", "const", "enum", "pattern", "required", "properties",
    "additionalProperties", "definitions", "$ref", "items", "minimum",
    "minLength", "uniqueItems",
}

def check_subset(node, path="schema"):
    if isinstance(node, dict):
        for k in node:
            if k in SUPPORTED_KEYS or k in META_KEYS:
                continue
            fail(f"schema uses keyword {k!r} at {path}, which this validator "
                 "does not implement — refuse rather than under-validate "
                 "(extend SUPPORTED_KEYS deliberately, in the same diff as the "
                 "schema bump)")
        for k in ("properties", "definitions"):
            if isinstance(node.get(k), dict):
                for name, sub in node[k].items():
                    check_subset(sub, f"{path}.{k}.{name}")
        if isinstance(node.get("items"), dict):
            check_subset(node["items"], f"{path}.items")
        if isinstance(node.get("additionalProperties"), dict):
            check_subset(node["additionalProperties"], f"{path}.additionalProperties")
    elif isinstance(node, list):
        for i, sub in enumerate(node):
            check_subset(sub, f"{path}[{i}]")

check_subset(schema)

TYPE_OK = {"string": lambda v: isinstance(v, str),
           "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
           "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
           "boolean": lambda v: isinstance(v, bool),
           "object": lambda v: isinstance(v, dict),
           "array": lambda v: isinstance(v, list)}

def resolve(ref):
    # Only "#/definitions/<name>" refs exist in this schema; a path ref is a
    # schema-shape change and must fail closed, not resolve loosely.
    m = re.match(r"^#/definitions/([A-Za-z0-9_]+)$", ref)
    if not m:
        fail(f"unresolvable $ref {ref!r} — the schema grew a reference shape this "
             "validator does not implement")
    node = schema.get("definitions", {}).get(m.group(1))
    if node is None:
        fail(f"$ref {ref!r} names no definition")
    return node

def validate(inst, sch, path):
    if "$ref" in sch:
        sch = resolve(sch["$ref"])
    if "type" in sch:
        t = sch["type"]
        if isinstance(t, list):
            ok = any(TYPE_OK[x](inst) for x in t)
        else:
            ok = TYPE_OK[t](inst)
        if not ok:
            fail(f"{path}: must be a {t}, got {type(inst).__name__} {inst!r}")
    if "const" in sch and inst != sch["const"]:
        fail(f"{path}: must be exactly {sch['const']!r}, got {inst!r}")
    if "enum" in sch and inst not in sch["enum"]:
        fail(f"{path}: {inst!r} is not one of {sch['enum']}")
    if "minimum" in sch and isinstance(inst, (int, float)) and inst < sch["minimum"]:
        fail(f"{path}: {inst!r} < minimum {sch['minimum']}")
    if "minLength" in sch and isinstance(inst, str) and len(inst) < sch["minLength"]:
        fail(f"{path}: shorter than minLength {sch['minLength']}")
    if "pattern" in sch and isinstance(inst, str):
        if not re.search(sch["pattern"], inst):
            fail(f"{path}: {inst!r} does not match {sch['pattern']}")
    if "object" in (sch.get("type"),) and isinstance(inst, dict):
        props = sch.get("properties", {})
        for k in sch.get("required", []):
            if k not in inst:
                fail(f"{path}: missing required property {k!r}")
        if sch.get("additionalProperties") is False:
            for k in inst:
                if k not in props:
                    fail(f"{path}: additional property {k!r} is not allowed "
                         "(schema additionalProperties: false)")
        for k, sub in props.items():
            if k in inst:
                validate(inst[k], sub, f"{path}.{k}")
    if "array" in (sch.get("type"),) and isinstance(inst, list):
        if "items" in sch:
            for i, item in enumerate(inst):
                validate(item, sch["items"], f"{path}[{i}]")
        if sch.get("uniqueItems"):
            dumped = [json.dumps(x, sort_keys=True, separators=(",", ":")) for x in inst]
            if len(set(dumped)) != len(dumped):
                fail(f"{path}: items are not unique (schema uniqueItems)")

validate(manifest, schema, "manifest")

# ── 2. Structural rules the schema cannot spell. Each failure names the entry
# (env_id-arch) and the rule.
envs = manifest.get("envs") if isinstance(manifest, dict) else []
if not isinstance(envs, list):
    fail("field 'envs' is not an array")
key_re = re.compile(r"^sha256:[0-9a-f]{64}$")
hex64 = re.compile(r"^[0-9a-f]{64}$")
base_ref_re = re.compile(r"^ghcr\.io/tinnlab/txresbench-base-(r|py):([0-9]+\.[0-9]+)$")
oci_prefix = "ghcr.io/tinnlab/txr-method-env-layers"
lang_by_key = {"r": "R", "py": "Python"}

seen = {}
for i, e in enumerate(envs):
    if not isinstance(e, dict):
        fail(f"envs[{i}] is not an object")
    ref = f"envs[{i}] {e.get('env_id')}-{e.get('arch')}"
    eid = e.get("env_id")
    if not isinstance(eid, str) or not re.match(r"^[a-z0-9._-]+$", eid):
        fail(f"{ref}: env_id {eid!r} is not a valid env id "
             "(modules/sandbox/env_id.rs::is_valid_env_id grammar)")
    if eid != e.get("method_id"):
        fail(f"{ref}: env_id != method_id (DEC-1 — the env id convention is "
             "env_id == method_id, enforced by the writer at assembly)")
    if e.get("arch") not in ("amd64", "arm64"):
        fail(f"{ref}: arch {e.get('arch')!r} not in amd64/arm64 (DEC-10)")
    if not isinstance(e.get("size_bytes"), int) or e.get("size_bytes") < 1:
        fail(f"{ref}: size_bytes {e.get('size_bytes')!r} is not a positive integer")
    for field in ("digest", "base_digest"):
        if not isinstance(e.get(field), str) or not key_re.match(e.get(field)):
            fail(f"{ref}: {field} {e.get(field)!r} is not sha256:<64 hex> "
                 "(the offline verification floor, DEC-7)")
    for field in ("layer_sha256", "wrapper_code_sha256"):
        if not isinstance(e.get(field), str) or not hex64.match(e.get(field)):
            fail(f"{ref}: {field} {e.get(field)!r} is not 64 lowercase hex")
    bm = base_ref_re.match(e.get("base_ref") or "")
    if not bm:
        fail(f"{ref}: base_ref {e.get('base_ref')!r} is not "
             "ghcr.io/tinnlab/txresbench-base-(r|py):<X.Y> (the benchmark base "
             "the delta was computed against)")
    else:
        key = bm.group(1)
        if lang_by_key[key] != e.get("language"):
            fail(f"{ref}: base_ref key {key!r} is inconsistent with language "
                 f"{e.get('language')!r} — a layer computed against the "
                 f"{key} base cannot declare itself {e.get('language')}")
        if bm.group(2) != e.get("contract"):
            fail(f"{ref}: base_ref tag {bm.group(2)} != contract "
                 f"{e.get('contract')!r} (a layer computed against one contract "
                 "cannot be declared as another)")
    if e.get("oci_ref") != f"{oci_prefix}/{eid}":
        fail(f"{ref}: oci_ref {e.get('oci_ref')!r} != {oci_prefix}/<env_id> (DEC-2)")
    version = e.get("method_version")
    if e.get("tag") != f"{version}-{e.get('arch')}":
        fail(f"{ref}: tag {e.get('tag')!r} != '<method_version>-<arch>' (DEC-2)")
    if e.get("layer_schema") != 1:
        fail(f"{ref}: layer_schema {e.get('layer_schema')!r} != 1 (DEC-11)")
    if e.get("contract") != manifest.get("base_contract"):
        fail(f"{ref}: contract {e.get('contract')!r} != the manifest's "
             f"base_contract {manifest.get('base_contract')!r} — mixed-contract "
             "manifests need a schema shape change, never a silent mix")
    if e.get("language") not in ("R", "Python"):
        fail(f"{ref}: language {e.get('language')!r} not in R/Python")
    if not isinstance(e.get("licence"), str) or not e.get("licence").strip():
        fail(f"{ref}: licence is empty (method.json's verbatim legal fact)")
    pair = (eid, e.get("arch"))
    if pair in seen:
        fail(f"{ref}: duplicate (env_id, arch) — {seen[pair]} already declares it "
             "(one entry per method per published arch)")
    seen[pair] = ref

# Sorted order (DEC-15): strict (env_id, arch) ascending, byte-determinism's
# precondition.
keys = [(e.get("env_id"), e.get("arch")) for e in envs]
for i in range(1, len(keys)):
    if keys[i] < keys[i - 1]:
        fail(f"envs[{i}] {keys[i][0]}-{keys[i][1]} sorts before envs[{i - 1}] "
             f"{keys[i - 1][0]}-{keys[i - 1][1]} — entries must be sorted by "
             "(env_id, arch) (DEC-15 determinism)")

if verbose:
    for e in envs:
        print(f"check-method-env-images: ok  {e.get('env_id')}-{e.get('arch')} "
              f"{e.get('method_version')} {e.get('size_bytes')} B")
print(f"check-method-env-images: OK — {len(envs)} env entr{'y' if len(envs) == 1 else 'ies'} "
      f"conform to {os.path.basename(schema_path)} and the structural rules")
PYEOF

# ── 4. Regen parity leg (publisher-machine check; see header). ─────────────────
if [ -n "$STAGING" ]; then
  if [ ! -d "$STAGING/layers" ]; then
    echo "check-method-env-images: FAIL: staging dir $STAGING has no layers/ — the regen parity leg cannot run" >&2
    exit 1
  fi
  rev="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["source_revision"])' "$MANIFEST")" || {
    echo "check-method-env-images: FAIL(2): cannot read source_revision from $MANIFEST" >&2
    exit 2
  }
  args=(--check --fixture "$STAGING" --manifest "$MANIFEST" --source-revision "$rev")
  if [ -n "$METHODS_DIR" ]; then
    args+=(--methods-dir "$METHODS_DIR")
  fi
  echo "check-method-env-images: regen parity at $rev against $STAGING ..."
  python3 "$REPO/scripts/generate-method-env-images.py" "${args[@]}" || exit 1
  exit 0
fi

if [ "$REQUIRE_PARITY" -eq 1 ]; then
  echo "check-method-env-images: FAIL: --require-parity but no staging dir " \
       "(pass --staging-dir <dir> / TXR_ENV_BUILD_DIR)" >&2
  exit 1
fi
echo "check-method-env-images: regen parity SKIPPED — no staging dir " \
     "(TXR_ENV_BUILD_DIR / --staging-dir); the layer hashes/sizes are docker " \
     "build outputs no committed file can re-derive (PLAN note n), so real-mode " \
     "parity is a publisher-machine check. Fixture parity runs in " \
     "check-method-env-images.test.mjs; --require-parity makes this a failure."
exit 0
