#!/usr/bin/env bash
# make-fixtures.sh — rebuild the method list's test fixtures (not run by the gate).
#
# Output (all committed):
#   list-dir/catalogue.json          the catalogue generator's own fixture output
#                                    (schema 2: 3 synthetic methods with their disease/
#                                    treatment facts and the study_options block)
#   list-dir/method-env-images.json  synthetic schema 2 list: two of its methods on amd64, both bases
#   list-dir/method-list.json        assembled with --first at SOURCE_DATE_EPOCH 1767225600
#   list-dir/method-list.json.minisig        good signature, "txresbench-method-list format=2 sequence=1"
#   signatures/legacy.minisig        the same comment, legacy (not prehashed) signature
#   signatures/wrong-purpose.minisig a minisign-style comment that is not the list's
#   signatures/sequence-2.minisig    "... sequence=2" over the sequence 1 body
#   test-key.pub / test-key.key      the TEST key pair (unencrypted). Never trusted by the app:
#                                    scripts/check-method-list.sh fails if it is in
#                                    data/method-list/trusted-keys.json.
#   fixture-keys.json                the test key in the trusted-keys format (for --keys / tests)
#
# The key pair is made once (minisign -G) and kept; everything else is rebuilt from it.
# ed25519 signatures are deterministic, so a rebuild with the same key gives the same bytes.
# minisign comes from PATH, or else runs in a throwaway container (docker, alpine's minisign
# package; only this folder is mounted).
set -euo pipefail

FIX=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH='' cd -- "$FIX/../../.." && pwd)
export PYTHONDONTWRITEBYTECODE=1

mkdir -p "$FIX/list-dir" "$FIX/signatures"
# The catalogue fixture: the generator's own fixture output (schema 2 — the disease/
# treatment facts and the study_options block come from the generator's fixture tables,
# the same tables that produce fixtures/expected-catalogue.json).
SOURCE_DATE_EPOCH=1767225600 python3 "$REPO/scripts/method-catalogue/gen_method_catalogue.py" \
  --fixtures --out "$FIX/list-dir/catalogue.json"

python3 - "$REPO" "$FIX/list-dir/method-env-images.json" <<'PY'
import hashlib, importlib.util, sys
repo, out = sys.argv[1], sys.argv[2]
spec = importlib.util.spec_from_file_location("gen_env", f"{repo}/scripts/generate-method-env-images.py")
gen = importlib.util.module_from_spec(spec); sys.modules["gen_env"] = gen; spec.loader.exec_module(gen)
h = lambda s: hashlib.sha256(s.encode()).hexdigest()
source_digest = {"py": "sha256:" + h("fixture base image py"), "r": "sha256:" + h("fixture base image r")}
bases = []
for base_id, fam in (("base-py", "py"), ("base-r", "r")):
    sq = h(f"fixture base squashfs {fam}")
    bases.append({"base_id": base_id, "arch": "amd64", "oci_ref": "ghcr.io/tinnlab/txresbench-env",
                  "tag": f"{base_id}-2.0-amd64-{sq[:12]}", "digest": "sha256:" + h(f"fixture base manifest {fam}"),
                  "squashfs_sha256": sq, "size_bytes": 1048576,
                  "source_ref": f"ghcr.io/tinnlab/txresbench-base-{fam}:2.0",
                  "source_digest": source_digest[fam], "contract": "2.0"})
envs = []
for mid, version, language, fam in (("fx-asm-methylation-panel", "1.0.0", "Python", "py"),
                                    ("fx-baseline-cox", "1.2.0", "R", "r")):
    layer = h(f"fixture layer {mid}")
    envs.append({"env_id": mid, "method_id": mid, "method_version": version, "language": language,
                 "arch": "amd64", "oci_ref": "ghcr.io/tinnlab/txr-method-env-layers",
                 "tag": f"{mid}-{version}-amd64-{layer[:12]}", "digest": "sha256:" + h(f"fixture manifest {mid}"),
                 "layer_sha256": layer, "size_bytes": 4096,
                 "base_ref": f"ghcr.io/tinnlab/txresbench-base-{fam}:2.0", "base_digest": source_digest[fam],
                 "contract": "2.0", "licence": "MIT (fixture)", "wrapper_code_sha256": h(f"fixture wrapper {mid}"),
                 "layer_schema": 1, "source_revision": h(f"fixture commit {mid}")[:12],
                 "source_tree": hashlib.sha1(f"fixture tree {mid}".encode()).hexdigest(),
                 "generator_version": gen.GENERATOR_VERSION})
doc = {"schema_version": 2, "generator_version": gen.GENERATOR_VERSION, "base_contract": "2.0",
       "bases": [{f: b[f] for f in gen.BASE_ENTRY_FIELDS} for b in bases],
       "envs": [{f: e[f] for f in gen.ENV_FIELDS} for e in envs]}
open(out, "wb").write(gen.manifest_bytes(doc))
PY

"$REPO/scripts/check-method-env-images.sh" --manifest "$FIX/list-dir/method-env-images.json" >/dev/null
SOURCE_DATE_EPOCH=1767225600 python3 "$REPO/scripts/assemble-method-list.py" \
  --list-dir "$FIX/list-dir" --first >/dev/null

COMMENT_OK='txresbench-method-list format=2 sequence=1'
SIGN_SCRIPT=$(cat <<EOF
set -eu
cd "\$1"
[ -f test-key.key ] || minisign -G -W -p test-key.pub -s test-key.key >/dev/null
sign() { out=\$1; shift; minisign -S -s test-key.key -m list-dir/method-list.json -x "\$out" -c 'txresbench-method-list fixture signature (test key)' "\$@" >/dev/null; }
sign list-dir/method-list.json.minisig -t '$COMMENT_OK'
sign signatures/legacy.minisig -l -t '$COMMENT_OK'
sign signatures/wrong-purpose.minisig -t 'timestamp:1767225600 file:method-list.json'
sign signatures/sequence-2.minisig -t 'txresbench-method-list format=2 sequence=2'
EOF
)
if command -v minisign >/dev/null 2>&1; then
  bash -c "$SIGN_SCRIPT" sign "$FIX"
else
  docker run --rm -v "$FIX:/fx" alpine:3.20 sh -c \
    "apk add --no-cache minisign >/dev/null && $SIGN_SCRIPT" sign /fx
fi

python3 - "$FIX" <<'PY'
import json, sys
fix = sys.argv[1]
comment, key = open(f"{fix}/test-key.pub").read().splitlines()[:2]
doc = {"format": "txresbench-method-list-keys", "format_version": 1,
       "keys": [{"label": "fixture test key (tests only, never trusted by the app)",
                 "key_id": comment.rsplit(" ", 1)[1], "public_key": key}]}
open(f"{fix}/fixture-keys.json", "w").write(json.dumps(doc, indent=1, sort_keys=True) + "\n")
PY
echo "make-fixtures: done ($FIX)"
