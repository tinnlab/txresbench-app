# shellcheck shell=bash
#
# method-env-verify.sh — BEHAVIOURAL verification of a built + staged
# method-env layer (node `method-env-images`, ITEM-7).
#
# ── WHY THIS EXISTS (env-image-verify.sh's precedent, one level over) ────────
# The publisher's pre-push checks (ITEM-5) verify the BYTE contract: the staged
# layer.squashfs hashes to the manifest entry's `layer_sha256`/`size_bytes` and
# the staged OCI manifest bytes match the entry `digest`. A layer can satisfy
# every one of those and still be wrong in the ways the layer design exists to
# prevent — a missing or 0600 `/code/run.py` (the benchmark's repeated failure),
# a schema marker that disagrees with the manifest entry, a `/layer-manifest.json`
# naming a path outside the allowed prefixes or a subtree the layer does not
# carry, a wrapper payload that does not hash to `wrapper_code_sha256`. None of
# those can be asserted from source (the generator's own source could drift and
# the STAGED BYTES would still be what the clinician's machine receives), so
# this library reads the BUILT ARTIFACT: extract the squashfs and verify the
# real files, modes and metadata. This is the ITEM-5 hook contract (PLAN note u):
# a non-zero exit refuses the publish (TEST-8) BEFORE any login or push.
#
# ── WHAT IT VERIFIES (design §2.2, §5, §5.1; PROV-method-env-images-3) ───────
#   1. the record the caller hands over is a schema-v1 artifact record;
#   2. layer.squashfs exists and its sha256 + size EQUAL the record's
#      `layer_sha256`/`size_bytes` (INV-4: the manifest value is the value);
#   3. the squashfs extracts (unsquashfs) and the schema marker
#      `/.txr-method-env-layer-schema` reads the same value as the record's
#      `layer_schema` (DEC-11 — the bytes say what they are);
#   4. `/code/method.json` and EXACTLY ONE of `/code/run.py` `/code/run.R`
#      (the record's `run_file` — a layer with both or neither is broken);
#   5. `wrapper_code_sha256` matches design §2.2's pinned byte convention
#      (sha256 of method.json bytes ‖ wrapper bytes — the method's own payload);
#   6. modes: no regular file below 0644, no directory below 0755 — a 0600
#      `/code/run.py` is the benchmark's recorded pitfall, refused here rather
#      than discovered by the first clinician to run the method (EX-7);
#   7. `/layer-manifest.json` is a JSON array of absolute, `..`-free paths
#      under `/usr/local`, `/opt` or `/code`, contains `/code`, every entry's
#      subtree EXISTS in the layer (a bind of an entry must reproduce the
#      method image's subtree at that path — §5.1), and the list equals the
#      record's `layer_manifest` (the runtime binds exactly what the record
#      claims); a named path outside the allowed prefixes refuses (PROV-3).
#
# ── WHAT IS NOT HERE, STATED (do not read a green as more than it is) ────────
# The STACKED-CONTRACT EQUIVALENCE — running the wrapper under base+layer and
# comparing its predictions to the full method image — is NOT this library:
# it is TEST-7 (`src-app/server/tests/sandbox/method_env_layer_test.rs`), the
# design §9 arbiter, because it needs the trimmed base rootfs and the sandbox
# runtime to stack with, neither of which the publisher call site has. This
# library is the PUBLISHER's gate: it verifies the artifact is the artifact
# the manifest describes and that its filesystem contract holds.
#
# ── EXIT CODES ──────────────────────────────────────────────────────────────
# 0 = verified (every check above passed);
# 1 = a contract violation (the artifact must not be published);
# 2 = usage/tooling (missing args, unreadable record, no unsquashfs — the
#     artifact was NOT judged either way).
#
# Usage (sourced by publish-method-env-images.sh, and by the controls suite):
#     . scripts/lib/method-env-verify.sh
#     txr_method_env_verify_layer <layer-dir> <artifact.json>

# The mount prefixes a layer entry may name — the runtime's compiled set
# (DEC-14 / stack.rs), mirrored here because the verifier is the publisher's
# copy of the same rule.
TXR_LAYER_ENTRY_PREFIXES='/usr/local /opt /code'

_txr_fail() { echo "[method-env] FAIL: $*" >&2; }

# sha256 of one file (lowercase hex). Prints nothing on error (caller checks rc).
_txr_sha256() {
  sha256sum "$1" 2>/dev/null | awk '{print $1}'
}

# Parse the artifact record with python3 (the generator's own parser is python;
# jq is not a build-machine requirement). Sets the TXR_RECORD_* variables the
# checks below read; exits 2 (not 1) on malformed input — that is tooling, not
# a verdict on the artifact.
_txr_read_record() {
  TXR_RECORD_FILE=$1
  TXR_RECORD_JSON=$(python3 - "$TXR_RECORD_FILE" <<'PYEOF' || exit 2
import json, sys
try:
    rec = json.load(open(sys.argv[1]))
except Exception as e:  # noqa: BLE001 - every failure here is "not a record"
    print(json.dumps({"__error__": f"{sys.argv[1]} is not valid JSON: {e}"}))
    sys.exit(0)
if not isinstance(rec, dict):
    print(json.dumps({"__error__": f"{sys.argv[1]} is not a JSON object"}))
    sys.exit(0)
rec.setdefault("__error__", None)
print(json.dumps(rec))
PYEOF
) || exit 2
  TXR_RECORD_ERR=$(printf '%s' "$TXR_RECORD_JSON" |
    python3 -c 'import json,sys; print(json.load(sys.stdin).get("__error__") or "")')
  if [ -n "$TXR_RECORD_ERR" ]; then
    echo "[method-env] usage: $TXR_RECORD_ERR" >&2
    exit 2
  fi
  TXR_RECORD_LAYER_SHA=$(printf '%s' "$TXR_RECORD_JSON" |
    python3 -c 'import json,sys; print(json.load(sys.stdin).get("layer_sha256") or "")')
  TXR_RECORD_SIZE=$(printf '%s' "$TXR_RECORD_JSON" |
    python3 -c 'import json,sys; print(json.load(sys.stdin).get("size_bytes") or "")')
  TXR_RECORD_SCHEMA=$(printf '%s' "$TXR_RECORD_JSON" |
    python3 -c 'import json,sys; print(json.load(sys.stdin).get("layer_schema") or "")')
  TXR_RECORD_RUN_FILE=$(printf '%s' "$TXR_RECORD_JSON" |
    python3 -c 'import json,sys; print(json.load(sys.stdin).get("run_file") or "")')
  TXR_RECORD_WRAPPER_SHA=$(printf '%s' "$TXR_RECORD_JSON" |
    python3 -c 'import json,sys; print(json.load(sys.stdin).get("wrapper_code_sha256") or "")')
  TXR_RECORD_ENV_ID=$(printf '%s' "$TXR_RECORD_JSON" |
    python3 -c 'import json,sys; print(json.load(sys.stdin).get("env_id") or "")')
  TXR_RECORD_ENTRIES=$(printf '%s' "$TXR_RECORD_JSON" |
    python3 -c '
import json, sys
rec = json.load(sys.stdin)
m = rec.get("layer_manifest")
if not isinstance(m, list) or not all(isinstance(x, str) for x in m):
    print("__NOT_A_STRING_LIST__")
else:
    print("\n".join(m))')
  TXR_RECORD_SCHEMA_VERSION=$(printf '%s' "$TXR_RECORD_JSON" |
    python3 -c 'import json,sys; print(json.load(sys.stdin).get("record_schema_version") or "")')
}

# The one function ITEM-5's publisher invokes (its header pins the contract):
#   txr_method_env_verify_layer <layer-dir> <artifact.json>
# All checks read the REAL bytes. Fail-fast on the first violation, printing an
# actionable diagnosis; nothing here can be satisfied by a comment.
txr_method_env_verify_layer() {
  if [ $# -ne 2 ]; then
    echo "[method-env] usage: txr_method_env_verify_layer <layer-dir> <artifact.json>" >&2
    return 2
  fi
  TXR_LAYER_DIR=$1
  TXR_RECORD_FILE=$2

  [ -d "$TXR_LAYER_DIR" ] || {
    _txr_fail "$TXR_LAYER_DIR is not a directory (first argument) — the staged layer cannot be verified"
    return 2
  }
  [ -f "$TXR_RECORD_FILE" ] || {
    _txr_fail "no artifact record at $TXR_RECORD_FILE — the layer has no record to verify against"
    return 2
  }
  TXR_SQUASHFS="$TXR_LAYER_DIR/layer.squashfs"
  [ -f "$TXR_SQUASHFS" ] || {
    _txr_fail "the staged layer has no layer.squashfs — nothing to publish or verify"
    return 1
  }

  _txr_read_record "$TXR_RECORD_FILE" || return 2
  [ "$TXR_RECORD_SCHEMA_VERSION" = "1" ] || {
    _txr_fail "the artifact record is not record_schema_version 1 (got ${TXR_RECORD_SCHEMA_VERSION:-missing});"
    _txr_fail "  the ITEM-2 generator's hand-off and the verifier agree on this fence — rebuilding"
    _txr_fail "  with the current generator is the path, never a record hand-edit"
    return 2
  }

  # ── 2. the byte contract: the staged file IS the manifest's file ────────────
  TXR_REAL_SHA=$(_txr_sha256 "$TXR_SQUASHFS")
  TXR_REAL_SIZE=$(wc -c < "$TXR_SQUASHFS" | tr -d ' ')
  if [ -z "$TXR_RECORD_LAYER_SHA" ] || [ -z "$TXR_RECORD_SIZE" ]; then
    _txr_fail "the record carries no layer_sha256/size_bytes; it is not a schema-v1 artifact record"
    return 2
  fi
  if [ "$TXR_REAL_SHA" != "$TXR_RECORD_LAYER_SHA" ]; then
    _txr_fail "layer.squashfs sha256 mismatch:"
    _txr_fail "  staged  $TXR_REAL_SHA"
    _txr_fail "  record  $TXR_RECORD_LAYER_SHA"
    _txr_fail "  the manifest's layer_sha256 is the value the runtime verifies — the bytes differ"
    return 1
  fi
  if [ "$TXR_REAL_SIZE" != "$TXR_RECORD_SIZE" ]; then
    _txr_fail "layer.squashfs size mismatch: staged $TXR_REAL_SIZE bytes, record $TXR_RECORD_SIZE"
    return 1
  fi

  # ── 3. extraction + schema marker ──────────────────────────────────────────
  if ! command -v unsquashfs >/dev/null 2>&1; then
    echo "[method-env] WARN: unsquashfs is not on PATH — the artifact cannot be" >&2
    echo "  extracted, so 3-7 below are NOT judged. Install squashfs-tools and" >&2
    echo "  re-run; a layer whose contents were never verified is not pushed." >&2
    return 2
  fi
  TXR_VERIFY_TMP=$(mktemp -d "${TMPDIR:-/tmp}/txr-method-env-verify.XXXXXX") || return 2
  trap 'rm -rf "$TXR_VERIFY_TMP"' RETURN
  if ! unsquashfs -d "$TXR_VERIFY_TMP/root" "$TXR_SQUASHFS" >/dev/null 2>&1; then
    _txr_fail "unsquashfs rejects $TXR_SQUASHFS — the file is not a readable squashfs"
    _txr_fail "  (a staged replacement, a truncation, or a corrupt pack; rebuild + re-stage)"
    return 1
  fi
  TXR_ROOT="$TXR_VERIFY_TMP/root"

  # The runtime's shared mount-readiness probe (`usr/ present == mounted`,
  # rootfs mount_at) applies to EVERY artifact the runtime mounts — the base
  # and the layer alike. A layer without a root-level `usr/` directory
  # (a code-only rule wrapper) mounts fine but is NEVER considered mounted and
  # every stacked run of it refuses with ROOTFS_MOUNT_FAILED (TEST-7 measured
  # this; design §5's sentinel). The sentinel is never a mount entry.
  if [ ! -d "$TXR_ROOT/usr" ]; then
    _txr_fail "the layer carries no root-level usr/ directory — the runtime's mount-"
    _txr_fail "  readiness probe usr/ == mounted would never accept it (ROOTFS_MOUNT_FAILED)"
    _txr_fail "  on every stacked run. The generator emits the sentinel; rebuild the layer."
    return 1
  fi

  TXR_MARKER=$(cat "$TXR_ROOT/.txr-method-env-layer-schema" 2>/dev/null || true)
  if [ "$TXR_MARKER" != "$TXR_RECORD_SCHEMA" ]; then
    _txr_fail "the in-squashfs schema marker reads '${TXR_MARKER:-<absent>}' but the record"
    _txr_fail "  declares layer_schema ${TXR_RECORD_SCHEMA:-<absent>} (DEC-11: the bytes say what they"
    _txr_fail "  are; the manifest value and the marker must agree)."
    return 1
  fi

  # ── 4. the wrapper payload: method.json + exactly one run file ─────────────
  TXR_METHOD_JSON="$TXR_ROOT/code/method.json"
  [ -f "$TXR_METHOD_JSON" ] || {
    _txr_fail "the layer carries no /code/method.json — the method's own payload is absent"
    return 1
  }
  TXR_PY_PRESENT=0; TXR_R_PRESENT=0
  [ -f "$TXR_ROOT/code/run.py" ] && TXR_PY_PRESENT=1
  [ -f "$TXR_ROOT/code/run.R" ] && TXR_R_PRESENT=1
  if [ $((TXR_PY_PRESENT + TXR_R_PRESENT)) -ne 1 ]; then
    _txr_fail "the layer must carry EXACTLY ONE of /code/run.py /code/run.R"
    _txr_fail "  (found: run.py=$TXR_PY_PRESENT run.R=$TXR_R_PRESENT) — the wrapper hash convention"
    _txr_fail "  and the runtime entrypoint derivation both need exactly one (design §2.2)"
    return 1
  fi
  TXR_RUN_FILE="run.py"
  [ "$TXR_R_PRESENT" = "1" ] && TXR_RUN_FILE="run.R"
  if [ "$TXR_RECORD_RUN_FILE" != "$TXR_RUN_FILE" ]; then
    _txr_fail "the record names run_file $TXR_RECORD_RUN_FILE but the layer carries /code/$TXR_RUN_FILE"
    return 1
  fi

  # ── 5. wrapper_code_sha256: method.json ‖ run file (design §2.2) ───────────
  TXR_WRAPPER_SHA=$(cat "$TXR_METHOD_JSON" "$TXR_ROOT/code/$TXR_RUN_FILE" | sha256sum | awk '{print $1}')
  if [ -z "$TXR_RECORD_WRAPPER_SHA" ] || [ "$TXR_WRAPPER_SHA" != "$TXR_RECORD_WRAPPER_SHA" ]; then
    _txr_fail "wrapper_code_sha256 mismatch — the layer's own payload bytes differ from the"
    _txr_fail "  manifest value:"
    _txr_fail "  layer   $TXR_WRAPPER_SHA"
    _txr_fail "  record  ${TXR_RECORD_WRAPPER_SHA:-<absent>}"
    _txr_fail "  (sha256 of /code/method.json ‖ /code/$TXR_RUN_FILE, the method's own bytes)"
    return 1
  fi

  # ── 6. modes: never a 0600 wrapper, never a file below 0644 / dir below 0755
  TXR_MODE_BAD=$(python3 - "$TXR_ROOT" "$TXR_RUN_FILE" <<'PYEOF'
import os, stat, sys
root, run = sys.argv[1], sys.argv[2]
bad = []
with open(os.path.join(root, "code", run), "rb") as f:
    pass  # opened only to stat via os.stat below
for base, dirs, files in os.walk(root):
    for d in dirs:
        st = os.stat(os.path.join(base, d))
        if (st.st_mode & 0o777) < 0o755:
            bad.append(("dir", os.path.join(base, d)[len(root):], oct(st.st_mode & 0o777)))
    for f in files:
        st = os.stat(os.path.join(base, f))
        if stat.S_ISREG(st.st_mode) and (st.st_mode & 0o777) < 0o644:
            bad.append(("file", os.path.join(base, f)[len(root):], oct(st.st_mode & 0o777)))
if bad:
    print("\n".join(f"{k} {p} {m}" for k, p, m in bad))
PYEOF
)
  if [ -n "$TXR_MODE_BAD" ]; then
    _txr_fail "mode violation in the layer (files must be >= 0644, dirs >= 0755):"
    printf '%s\n' "$TXR_MODE_BAD" | sed 's/^/  /' >&2
    _txr_fail "  a 0600 /code/run.py is the benchmark's recorded pitfall — the container user"
    _txr_fail "  cannot read the wrapper; a rebuild must normalize modes, not a hand chmod"
    return 1
  fi

  # ── 7. /layer-manifest.json: the bind contract ─────────────────────────────
  TXR_LAYER_MANIFEST="$TXR_ROOT/layer-manifest.json"
  [ -f "$TXR_LAYER_MANIFEST" ] || {
    _txr_fail "the layer carries no /layer-manifest.json — the runtime binds nothing (PROV-SS-2)"
    return 1
  }
  TXR_BAD_ENTRY=$(python3 - "$TXR_LAYER_MANIFEST" "$TXR_ROOT" <<'PYEOF'
import json, os, sys
path, root = sys.argv[1], sys.argv[2]
prefixes = ("/usr/local", "/opt", "/code")
try:
    entries = json.load(open(path))
except Exception as e:
    print(f"not a JSON array: {e}")
    sys.exit(0)
if not isinstance(entries, list) or not all(isinstance(e, str) for e in entries):
    print("not a JSON array of strings")
    sys.exit(0)
bad = []
for e in entries:
    if not e.startswith("/"):
        bad.append(f"{e!r} is not absolute")
    elif ".." in e.split("/"):
        bad.append(f"{e!r} carries '..'")
    elif not any(e == p or e.startswith(p + "/") for p in prefixes):
        bad.append(f"{e!r} is outside the allowed prefixes {list(prefixes)}")
    else:
        rel = e.lstrip("/")
        if not os.path.exists(os.path.join(root, rel)):
            bad.append(f"{e!r} does not exist in the layer — a bind of it would be empty")
if "/code" not in entries:
    bad.append("/code is not an entry — the layer's wrapper is unbindable")
print("\n".join(sorted(set(bad))))
PYEOF
)
  if [ -n "$TXR_BAD_ENTRY" ]; then
    _txr_fail "/layer-manifest.json refuses:"
    printf '%s\n' "$TXR_BAD_ENTRY" | sed 's/^/  /' >&2
    return 1
  fi
  if [ -n "$TXR_RECORD_ENTRIES" ] && [ "$TXR_RECORD_ENTRIES" = "__NOT_A_STRING_LIST__" ]; then
    _txr_fail "the record's layer_manifest is not a string list; it cannot be the bind contract"
    return 2
  fi
  TXR_LAYER_ENTRIES=$(python3 -c '
import json, sys
print("\n".join(json.load(open(sys.argv[1]))))' "$TXR_LAYER_MANIFEST")
  if [ "$TXR_RECORD_ENTRIES" != "$TXR_LAYER_ENTRIES" ]; then
    _txr_fail "the layer's /layer-manifest.json and the record's layer_manifest disagree:"
    _txr_fail "  layer   $(printf '%s' "$TXR_LAYER_ENTRIES" | tr '\n' ' ')"
    _txr_fail "  record  $(printf '%s' "$TXR_RECORD_ENTRIES" | tr '\n' ' ')"
    return 1
  fi

  echo "[method-env] verified: $TXR_RECORD_ENV_ID layer.squashfs ($TXR_REAL_SIZE B,"
  echo "  $TXR_REAL_SHA), schema marker $TXR_MARKER, wrapper /code/$TXR_RUN_FILE,"
  echo "  $(printf '%s\n' "$TXR_LAYER_ENTRIES" | wc -l | tr -d ' ') mount entries"
  return 0
}
