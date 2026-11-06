#!/usr/bin/env python3
"""Deterministic .txr writer for pretrained models (ITEM-1, CONS-PC-5).

Packs ONE model tree + one facts file into the model-store's .txr container
format (single-writer here, single-reader there: the store's reader is the
acceptance check, TEST-PC-10). The packer never interprets model content —
the tree is opaque bytes (INV-2); it only names the files and hashes them.

Container layout (the store's codec, mirrored exactly — magic, u32 header
length, header JSON, per-model u32 entry count, per entry u16 relpath length +
UTF-8 relpath + u64 byte length + bytes + raw 32-byte sha256, u64 training
entry count, end magic):

    TXR_MODL\\0 <u32 header_len> <header> <u32 entry_count> <entries...>
    <u64 0> TXR_MODLEND\\0

The header is a single-model container: format_version 1, kind "model",
set null, training null, one model entry. Every recorded model fact the
header carries is either given in facts.json or derived:

  given   : name*, token*, method_id, method_version, group, group_label,
            task, decision_day, endpoint, horizon, contract,
            env{base_digest, layer_digest}, features, required_markers,
            marker_facts, covariates, embeds_training_data,
            trained_on_patients, trained_at, own_auc, own_c, catalogue_id,
            licence
  derived : provenance{kind "pretrained", imported_from null, catalogue_id,
            licence}; tree_sha256 (PROV-SS-3 over the sorted regular files);
            size_bytes (sum of the carried file bytes)
  defaults: name -> method_id, token -> catalogue_id when omitted

Determinism: the tree walk is sorted, entries are sorted by relpath bytes,
the digest order IS the entry order, and the header JSON is compact with
fields in fixed order — the same tree + facts produce byte-identical
output.

Invariant of the walk: every regular file participates and ANY symlink,
fifo, socket or device in the tree refuses the pack (a published tree must
not silently drop bytes — the store's digest would skip them; the packer
refuses instead). Relpaths are validated with the store's safety rule
(UNSAFE_PATH): relative, '/'-separated, no empty/'.'/'..' segments, no
'\\' or ':' (cross-platform hazard), UTF-8 only.

Usage:
    pack_model_txr.py --tree <dir> --facts facts.json --out <file.txr>
    pack_model_txr.py --verify <file.txr>
    pack_model_txr.py --selftest

On success prints (stdout, nothing else):
    size_bytes: <N>
    sha256: <lowercase hex sha256 of the whole container>

Every refusal is `ERROR <CODE>: <detail>` on stderr, exit 1, and the output
file is never created (all validation happens before the first byte of
output).
"""

import argparse
import datetime
import hashlib
import json
import math
import os
import re
import shutil
import stat
import struct
import sys
import tempfile

# The store's codec constants (container.rs — the anti-drift boundary).
MAGIC = b"TXR_MODL\0"
END_MAGIC = b"TXR_MODLEND\0"
FORMAT_VERSION = 1
MAX_HEADER_BYTES = 16 * 1024 * 1024  # the store's MAX_HEADER_BYTES
U32 = "<I"
U16 = "<H"
U64 = "<Q"

# The exact facts the header requires from the caller (the plan's list; the
# packer derives the rest). Optional: name, token.
REQUIRED_FACTS = [
    "catalogue_id",
    "licence",
    "method_id",
    "method_version",
    "group",
    "group_label",
    "task",
    "decision_day",
    "endpoint",
    "horizon",
    "contract",
    "env",
    "features",
    "required_markers",
    "marker_facts",
    "covariates",
    "embeds_training_data",
    "trained_on_patients",
    "trained_at",
    "own_auc",
    "own_c",
]

TASK_VALUES = ("pfs", "os", "response")
ENDPOINT_VALUES = ("pfs", "os")
MATCH_VALUES = ("all", "min_fraction")
MARKER_KIND_VALUES = ("any", "single", "panel", "multi")
USES_HISTORY_VALUES = ("landmark", "full")
COVARIATE_MODE_VALUES = ("none", "optional", "required")
RFC3339 = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$"
)


class PackError(Exception):
    """A named refusal — the caller prints `ERROR <code>: <message>`."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def refuse(code, message):
    raise PackError(code, message)


# ────────────────────────────── relpath safety ──────────────────────────────

def validate_relpath(relpath, code="TREE_UNSAFE_PATH"):
    """The store's UNSAFE_PATH rule (container.rs `validate_relpath`)."""
    if not relpath:
        refuse(code, "an entry path is empty")
    if relpath.startswith("/"):
        refuse(code, "an entry path is absolute: %r" % relpath)
    if "\\" in relpath or ":" in relpath:
        refuse(
            code,
            "an entry path contains a cross-platform hazard character: %r" % relpath,
        )
    for seg in relpath.split("/"):
        if not seg:
            refuse(code, "an entry path has an empty segment: %r" % relpath)
        if seg in (".", ".."):
            refuse(code, "an entry path escapes the tree: %r" % relpath)
    return relpath


# ────────────────────────────── tree walk ──────────────────────────────

def collect_tree_files(root):
    """The tree's regular files as sorted [(relpath, abs path)].

    Sorted by relpath BYTES (the digest's order). Refuses a symlink, fifo,
    socket or device anywhere in the tree. A directory symlink refuses too
    (the walk never descends through it; the refusal is the point).
    """
    if not os.path.isdir(root):
        refuse("TREE_NOT_DIR", "the model tree is not a directory: %s" % root)

    out = []

    def onerror(exc):
        refuse("TREE_READ_FAILED", "list %s: %s" % (exc.filename, exc))

    for dirpath, dirnames, filenames in os.walk(root, topdown=True, followlinks=False, onerror=onerror):
        dirnames.sort()
        filenames.sort()
        for name in filenames:
            path = os.path.join(dirpath, name)
            mode = os.lstat(path).st_mode
            if stat.S_ISLNK(mode) or not stat.S_ISREG(mode):
                refuse(
                    "TREE_NON_REGULAR_FILE",
                    "the tree carries a non-regular file: %s" % path,
                )
            rel = os.path.relpath(path, root).replace(os.sep, "/")
            try:
                rel.encode("utf-8")
            except UnicodeEncodeError:
                refuse("TREE_UNSAFE_PATH", "a tree file name is not valid UTF-8: %r" % name)
            validate_relpath(rel)
            out.append((rel, path))
        for name in dirnames:
            path = os.path.join(dirpath, name)
            mode = os.lstat(path).st_mode
            if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
                refuse(
                    "TREE_NON_REGULAR_FILE",
                    "the tree carries a non-regular entry: %s" % path,
                )

    if not out:
        refuse("TREE_EMPTY", "the model tree carries no regular files: %s" % root)
    # Byte order, exactly like the Rust sort on the relpath bytes.
    out.sort(key=lambda item: item[0].encode("utf-8"))
    return out


def sha256_file(path):
    hasher = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def tree_sha256(entries):
    """PROV-SS-3 digest over the SORTED [(relpath, hex_sha256)] (tree) pairs."""
    hasher = hashlib.sha256()
    for rel, _size, hexdigest in entries:
        hasher.update(rel.encode("utf-8"))
        hasher.update(b"\x00")
        hasher.update(hexdigest.encode("ascii"))
        hasher.update(b"\n")
    return hasher.hexdigest()


# ────────────────────────────── facts validation ──────────────────────────────

def require_nonempty_str(facts, key):
    value = facts.get(key)
    if not isinstance(value, str) or not value:
        refuse("FACTS_EMPTY_FIELD", "the facts field %r is empty" % key)
    return value


def require_number(facts, key):
    value = facts.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        refuse("FACTS_BAD_VALUE", "the facts field %r is not a number" % key)
    value = float(value)
    if not math.isfinite(value):
        refuse("FACTS_BAD_VALUE", "the facts field %r is not finite" % key)
    return value


def require_int(facts, key):
    value = facts.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        refuse("FACTS_BAD_VALUE", "the facts field %r is not an integer" % key)
    if value < 0:
        refuse("FACTS_BAD_VALUE", "the facts field %r is negative" % key)
    return int(value)


def require_bool(facts, key):
    value = facts.get(key)
    if not isinstance(value, bool):
        refuse("FACTS_BAD_VALUE", "the facts field %r is not a boolean" % key)
    return value


def is_nullable_number(value):
    return value is None or (not isinstance(value, bool) and isinstance(value, (int, float)))


def normalize_facts(facts):
    """Validate the facts and return the header's model entry (minus the
    derived tree fields). Every code names the failing field."""
    for key in REQUIRED_FACTS:
        if key not in facts:
            refuse("FACTS_MISSING_FIELD", "the facts lack the required field %r" % key)

    catalogue_id = require_nonempty_str(facts, "catalogue_id")
    licence = facts.get("licence")
    if not isinstance(licence, str):
        refuse("FACTS_EMPTY_FIELD", "the facts field 'licence' is not a string")
    if not licence.strip():
        refuse("LICENCE_EMPTY", "the facts licence is empty after trimming")

    name = facts.get("name", facts["method_id"])
    if not isinstance(name, str) or not name:
        refuse("FACTS_EMPTY_FIELD", "the facts field 'name' is empty")
    token = facts.get("token", catalogue_id)
    if not isinstance(token, str) or not token:
        refuse("FACTS_EMPTY_FIELD", "the facts field 'token' is empty")

    method_id = require_nonempty_str(facts, "method_id")
    method_version = require_nonempty_str(facts, "method_version")
    group = require_nonempty_str(facts, "group")
    group_label = require_nonempty_str(facts, "group_label")
    contract = require_nonempty_str(facts, "contract")

    task = facts.get("task")
    if task is not None and task not in TASK_VALUES:
        refuse("FACTS_BAD_VALUE", "the facts field 'task' is not one of %s" % (TASK_VALUES,))
    decision_day = require_number(facts, "decision_day")
    endpoint = facts.get("endpoint")
    if endpoint not in ENDPOINT_VALUES:
        refuse("FACTS_BAD_VALUE", "the facts field 'endpoint' is not one of %s" % (ENDPOINT_VALUES,))
    horizon = require_number(facts, "horizon")

    env = facts.get("env")
    if not isinstance(env, dict):
        refuse("FACTS_MISSING_FIELD", "the facts lack the required field 'env'")
    for part in ("base_digest", "layer_digest"):
        if part not in env:
            refuse("FACTS_MISSING_FIELD", "the facts lack the required field 'env.%s'" % part)
        if not isinstance(env[part], str) or not env[part]:
            refuse("FACTS_EMPTY_FIELD", "the facts field 'env.%s' is empty" % part)

    features = facts.get("features")
    if not isinstance(features, list) or any(
        not isinstance(f, str) or not f for f in features
    ):
        refuse("FACTS_BAD_VALUE", "the facts field 'features' is not a list of non-empty strings")

    required_markers = facts.get("required_markers")
    if required_markers is not None:
        if not isinstance(required_markers, dict):
            refuse("FACTS_BAD_VALUE", "the facts field 'required_markers' is not an object")
        markers = required_markers.get("markers")
        if not isinstance(markers, list):
            refuse("FACTS_BAD_VALUE", "the facts field 'required_markers.markers' is not a list")
        for entry in markers:
            if not isinstance(entry, dict):
                refuse("FACTS_BAD_VALUE", "a required marker is not an object")
            for sub in ("name", "id_system", "id"):
                if not isinstance(entry.get(sub), str) or not entry[sub]:
                    refuse(
                        "FACTS_EMPTY_FIELD",
                        "a required marker's %r is empty" % sub,
                    )
        if required_markers.get("match") not in MATCH_VALUES:
            refuse(
                "FACTS_BAD_VALUE",
                "the facts field 'required_markers.match' is not one of %s" % (MATCH_VALUES,),
            )
        min_fraction = required_markers.get("min_fraction")
        if isinstance(min_fraction, bool) or not isinstance(min_fraction, (int, float)):
            refuse("FACTS_BAD_VALUE", "the facts field 'required_markers.min_fraction' is not a number")
        if not isinstance(required_markers.get("list_source"), str) or not required_markers["list_source"]:
            refuse("FACTS_EMPTY_FIELD", "the facts field 'required_markers.list_source' is empty")

    marker_facts = facts.get("marker_facts")
    if not isinstance(marker_facts, dict):
        refuse("FACTS_BAD_VALUE", "the facts field 'marker_facts' is not an object")
    if marker_facts.get("kind") not in MARKER_KIND_VALUES:
        refuse(
            "FACTS_BAD_VALUE",
            "the facts field 'marker_facts.kind' is not one of %s" % (MARKER_KIND_VALUES,),
        )
    for key in ("count", "min_draws"):
        if isinstance(marker_facts.get(key), bool) or not isinstance(marker_facts.get(key), int):
            refuse("FACTS_BAD_VALUE", "the facts field 'marker_facts.%s' is not an integer" % key)
    for key in ("needs_baseline", "needs_detection_call"):
        if not isinstance(marker_facts.get(key), bool):
            refuse("FACTS_BAD_VALUE", "the facts field 'marker_facts.%s' is not a boolean" % key)
    if marker_facts.get("uses_history") not in USES_HISTORY_VALUES:
        refuse(
            "FACTS_BAD_VALUE",
            "the facts field 'marker_facts.uses_history' is not one of %s" % (USES_HISTORY_VALUES,),
        )
    groups = marker_facts.get("marker_groups_required")
    if not isinstance(groups, list) or any(not isinstance(g, str) for g in groups):
        refuse(
            "FACTS_BAD_VALUE",
            "the facts field 'marker_facts.marker_groups_required' is not a list of strings",
        )

    covariates = facts.get("covariates")
    if not isinstance(covariates, dict):
        refuse("FACTS_BAD_VALUE", "the facts field 'covariates' is not an object")
    if covariates.get("catalogue") not in COVARIATE_MODE_VALUES:
        refuse(
            "FACTS_BAD_VALUE",
            "the facts field 'covariates.catalogue' is not one of %s" % (COVARIATE_MODE_VALUES,),
        )
    if not isinstance(covariates.get("used"), bool):
        refuse("FACTS_BAD_VALUE", "the facts field 'covariates.used' is not a boolean")

    embeds_training_data = require_bool(facts, "embeds_training_data")

    trained_on_patients = facts.get("trained_on_patients")
    if trained_on_patients is not None:
        if isinstance(trained_on_patients, bool) or not isinstance(trained_on_patients, int):
            refuse("FACTS_BAD_VALUE", "the facts field 'trained_on_patients' is not an integer")
        if trained_on_patients < 0:
            refuse("FACTS_BAD_VALUE", "the facts field 'trained_on_patients' is negative")

    trained_at = facts.get("trained_at")
    if trained_at is not None:
        if not isinstance(trained_at, str) or not RFC3339.match(trained_at):
            refuse("FACTS_BAD_VALUE", "the facts field 'trained_at' is not an RFC3339 timestamp")
        try:
            datetime.datetime.fromisoformat(trained_at.replace("Z", "+00:00"))
        except ValueError:
            refuse("FACTS_BAD_VALUE", "the facts field 'trained_at' is not a valid RFC3339 timestamp")

    own_auc = facts.get("own_auc")
    own_c = facts.get("own_c")
    for key, value in (("own_auc", own_auc), ("own_c", own_c)):
        if value is not None:
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                refuse("FACTS_BAD_VALUE", "the facts field %r is not a number" % key)
            if not math.isfinite(float(value)):
                refuse("FACTS_BAD_VALUE", "the facts field %r is not finite" % key)

    return {
        # ContainerModel: token first, then the flattened facts (the field
        # order of container.rs ContainerModelFacts), then the derived pair.
        "token": token,
        "name": name,
        "method_id": method_id,
        "method_version": method_version,
        "group": group,
        "group_label": group_label,
        "task": task,
        "provenance": {
            "kind": "pretrained",
            "imported_from": None,
            "catalogue_id": catalogue_id,
            "licence": licence,
        },
        "trained_on_patients": trained_on_patients,
        "trained_at": trained_at,
        "decision_day": decision_day,
        "endpoint": endpoint,
        "horizon": horizon,
        "contract": contract,
        "env": {"base_digest": env["base_digest"], "layer_digest": env["layer_digest"]},
        "features": list(features),
        "required_markers": required_markers,
        "marker_facts": marker_facts,
        "covariates": covariates,
        "embeds_training_data": embeds_training_data,
        "own_auc": own_auc,
        "own_c": own_c,
    }


# ────────────────────────────── pack ──────────────────────────────

class HashingWriter:
    """Streams writes while counting bytes and hashing them (the container's
    sha256 without a second read of the whole file)."""

    def __init__(self, out):
        self.out = out
        self.size = 0
        self.hasher = hashlib.sha256()

    def write(self, more):
        self.out.write(more)
        self.hasher.update(more)
        self.size += len(more)

    def hexdigest(self):
        return self.hasher.hexdigest()


def pack(tree_dir, facts_path, out_path):
    """Validate everything, then write — a refusal never creates the output."""
    with open(facts_path, "r", encoding="utf-8") as f:
        try:
            facts = json.load(f)
        except (ValueError, UnicodeDecodeError) as exc:
            refuse("FACTS_NOT_JSON", "facts.json is not valid JSON: %s" % exc)
    if not isinstance(facts, dict):
        refuse("FACTS_NOT_OBJECT", "facts.json must be a JSON object")

    model = normalize_facts(facts)

    files = collect_tree_files(tree_dir)

    # First pass: hash + size every file. The record order is the sorted
    # relpath order; the digest and the entry list share it.
    entries = []
    for rel, path in files:
        hexdigest = sha256_file(path)
        entries.append((rel, os.path.getsize(path), hexdigest))

    model["tree_sha256"] = tree_sha256(entries)
    model["size_bytes"] = sum(size for _rel, size, _digest in entries)

    header = {
        "format_version": FORMAT_VERSION,
        "kind": "model",
        "set": None,
        "models": [model],
        "training": None,
    }
    header_bytes = json.dumps(header, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if not header_bytes or len(header_bytes) > MAX_HEADER_BYTES:
        refuse("HEADER_TOO_LARGE", "the .txr header is %d bytes" % len(header_bytes))

    # All validation is done — the output file opens now, and nothing is left
    # behind on failure.
    try:
        out = open(out_path, "wb")
    except OSError as exc:
        refuse("OUT_OPEN_FAILED", "open %s: %s" % (out_path, exc))

    writer = HashingWriter(out)
    try:
        writer.write(MAGIC)
        writer.write(struct.pack(U32, len(header_bytes)))
        writer.write(header_bytes)
        writer.write(struct.pack(U32, len(entries)))
        for rel, size, hexdigest in entries:
            rel_bytes = rel.encode("utf-8")
            writer.write(struct.pack(U16, len(rel_bytes)))
            writer.write(rel_bytes)
            writer.write(struct.pack(U64, size))
            # Second pass re-reads the bytes (a tree that changed between the
            # hashes and the write would fail verification — refuse instead).
            hasher = hashlib.sha256()
            with open(os.path.join(tree_dir, rel), "rb") as f:
                remaining = size
                while remaining > 0:
                    chunk = f.read(min(remaining, 1 << 20))
                    if not chunk:
                        refuse("TREE_CHANGED", "a tree file shortened while packing: %s" % rel)
                    writer.write(chunk)
                    hasher.update(chunk)
                    remaining -= len(chunk)
            if hasher.hexdigest() != hexdigest:
                refuse("TREE_CHANGED", "a tree file changed while packing: %s" % rel)
            writer.write(hasher.digest())
        writer.write(struct.pack(U64, 0))
        writer.write(END_MAGIC)
    except BaseException:
        out.close()
        try:
            os.remove(out_path)
        except OSError:
            pass
        raise
    out.close()
    return writer.size, writer.hexdigest()


# ────────────────────────────── verify ──────────────────────────────

class HashingReader:
    """Sequential reads while counting bytes and hashing them — the verify
    mode watches every byte, framing and payload alike."""

    def __init__(self, path):
        self.f = open(path, "rb")
        self.size = 0
        self.hasher = hashlib.sha256()

    def read(self, n, what):
        data = self.f.read(n)
        if len(data) != n:
            raise PackError("VERIFY_TRUNCATED", "the container ends inside %s" % what)
        self.hasher.update(data)
        self.size += len(data)
        return data

    def u32(self):
        return struct.unpack(U32, self.read(4, "a u32"))[0]

    def u16(self):
        return struct.unpack(U16, self.read(2, "a u16"))[0]

    def u64(self):
        return struct.unpack(U64, self.read(8, "a u64"))[0]

    def hexdigest(self):
        return self.hasher.hexdigest()

    def close(self):
        self.f.close()


def verify_container(path):
    """Re-open a packed container and validate it like the store's reader:
    per-entry sha256, the PROV-SS-3 tree sha256, the end magic, no trailing
    bytes, and the header's single-model shape. Prints the same two lines as
    pack mode. Streaming — never buffers the payload."""
    reader = HashingReader(path)
    try:
        if reader.read(9, "the leading magic") != MAGIC:
            refuse("VERIFY_BAD_MAGIC", "the leading magic is not a .txr container")
        header_len = reader.u32()
        if header_len == 0 or header_len > MAX_HEADER_BYTES:
            refuse("VERIFY_BAD_HEADER", "the header length is %d" % header_len)
        header_bytes = reader.read(header_len, "the header")
        try:
            header = json.loads(header_bytes.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as exc:
            refuse("VERIFY_BAD_HEADER", "the header is not valid JSON: %s" % exc)

        if not isinstance(header, dict) or header.get("format_version") != FORMAT_VERSION:
            refuse("VERIFY_BAD_HEADER", "the header is not format_version %d" % FORMAT_VERSION)
        if header.get("kind") != "model":
            refuse("VERIFY_BAD_HEADER", "the container is not a single-model .txr")
        if header.get("set") is not None:
            refuse("VERIFY_BAD_HEADER", "a single-model container carries a set block")
        models = header.get("models")
        if not isinstance(models, list) or len(models) != 1:
            refuse("VERIFY_BAD_HEADER", "a single-model container carries exactly one model")
        if header.get("training"):
            refuse("VERIFY_BAD_HEADER", "a single-model container carries training files")
        model = models[0]
        if not isinstance(model, dict) or not isinstance(model.get("token"), str) or not model["token"]:
            refuse("VERIFY_BAD_HEADER", "the model entry has no token")

        entry_count = reader.u32()
        if entry_count == 0:
            refuse("VERIFY_BAD_HEADER", "the model section carries no entries")
        seen = set()
        pairs = []
        size_sum = 0
        for _ in range(entry_count):
            rel_len = reader.u16()
            if rel_len == 0:
                refuse("VERIFY_BAD_HEADER", "an entry path is empty")
            rel_bytes = reader.read(rel_len, "an entry path")
            try:
                rel = rel_bytes.decode("utf-8")
            except UnicodeDecodeError:
                refuse("VERIFY_BAD_RELPATH", "an entry path is not UTF-8")
            validate_relpath(rel, "VERIFY_BAD_RELPATH")
            if rel in seen:
                refuse("VERIFY_BAD_RELPATH", "an entry path repeats: %s" % rel)
            seen.add(rel)
            bytes_len = reader.u64()
            hasher = hashlib.sha256()
            remaining = bytes_len
            while remaining > 0:
                chunk = reader.read(min(remaining, 1 << 20), "an entry payload")
                hasher.update(chunk)
                remaining -= len(chunk)
            declared = reader.read(32, "an entry sha256")
            if hasher.digest() != declared:
                refuse("VERIFY_ENTRY_DIGEST_MISMATCH", "the entry %s fails its sha256" % rel)
            pairs.append((rel, bytes_len, hasher.hexdigest()))
            size_sum += bytes_len

        if size_sum != model.get("size_bytes"):
            refuse(
                "VERIFY_SIZE_MISMATCH",
                "the model section declares %s bytes but carries %d" % (model.get("size_bytes"), size_sum),
            )
        expected_digest = model.get("tree_sha256")
        # The digest's order is relpath BYTE order — not the payload order
        # (the store's reader re-derives it from the restored tree).
        pairs.sort(key=lambda item: item[0].encode("utf-8"))
        if tree_sha256(pairs) != expected_digest:
            refuse("VERIFY_TREE_DIGEST_MISMATCH", "the tree sha256 does not match the header")

        training_count = reader.u64()
        if training_count != 0:
            refuse("VERIFY_BAD_HEADER", "the container carries training entries")
        if reader.read(12, "the end magic") != END_MAGIC:
            refuse("VERIFY_END_MAGIC", "the container's end magic is missing")
        if reader.f.read(1):
            refuse("VERIFY_TRAILING_BYTES", "trailing bytes after the container's end magic")
        return reader.size, reader.hexdigest()
    finally:
        reader.close()


# ────────────────────────────── selftest ──────────────────────────────

def _expect_refusal(label, fn, code):
    try:
        fn()
    except PackError as exc:
        assert exc.code == code, "%s: expected %s, got %s" % (label, code, exc.code)
        return
    assert False, "%s: expected the refusal %s" % (label, code)


def _facts():
    return {
        "name": "Fx pretrained rule",
        "token": "fx-rule-001",
        "catalogue_id": "fx-rule-001",
        "licence": "CC0 1.0 (synthetic fixture)",
        "method_id": "fx-pretrained-rule",
        "method_version": "1.0.0",
        "group": "response-call",
        "group_label": "Response call",
        "task": "response",
        "decision_day": 56.0,
        "endpoint": "pfs",
        "horizon": 238.0,
        "contract": "2.0",
        "env": {"base_digest": "ab" * 32, "layer_digest": "cd" * 32},
        "features": ["fx-mark-01"],
        "required_markers": {
            "markers": [{"name": "fx marker 01", "id_system": "FX-SYS", "id": "fx-01"}],
            "match": "all",
            "min_fraction": 1.0,
            "list_source": "Synthetic fixture marker rule",
        },
        "marker_facts": {
            "kind": "single",
            "count": 1,
            "min_draws": 2,
            "needs_baseline": True,
            "uses_history": "landmark",
            "needs_detection_call": False,
            "marker_groups_required": [],
        },
        "covariates": {"catalogue": "none", "used": False},
        "embeds_training_data": False,
        "trained_on_patients": 312,
        "trained_at": "2026-10-19T14:30:00Z",
        "own_auc": 0.66,
        "own_c": 0.63,
    }


def selftest():
    """TEST-PC-11's matrix: every refusal shape + the happy path. Runs in a
    scratch dir under the ambient TMPDIR (never /tmp by convention)."""
    tmp = tempfile.mkdtemp(prefix="pack-model-txr-")
    try:
        tree = os.path.join(tmp, "tree")
        weights = os.path.join(tree, "weights")
        os.makedirs(weights)
        with open(os.path.join(tree, "model.json"), "w", encoding="utf-8") as f:
            f.write('{"contract":"2.0","unit":"fx-rule-001"}')
        with open(os.path.join(weights, "tree-01.bin"), "wb") as f:
            f.write(bytes(range(96)))

        facts_path = os.path.join(tmp, "facts.json")
        with open(facts_path, "w", encoding="utf-8") as f:
            json.dump(_facts(), f)

        # ── the relpath rule (UNSAFE_PATH) ──
        for bad in ("", "/abs", "../x", "a/../b", "a/./b", "a//b", "a\\b", "a:b"):
            _expect_refusal(
                "relpath %r" % bad,
                lambda b=bad: validate_relpath(b),
                "TREE_UNSAFE_PATH",
            )

        # ── the happy path: pack → verify → byte stability ──
        out1 = os.path.join(tmp, "m1.txr")
        out2 = os.path.join(tmp, "m2.txr")
        size, digest = pack(tree, facts_path, out1)
        with open(out1, "rb") as f:
            first = f.read()
        assert first.startswith(MAGIC), "leading magic"
        assert first.endswith(END_MAGIC), "end magic"
        assert digest == hashlib.sha256(first).hexdigest(), "printed sha256"
        assert size == len(first), "printed size"
        pack(tree, facts_path, out2)
        with open(out2, "rb") as f:
            assert f.read() == first, "two packs are byte-identical"

        # ── the refusals: nothing is written ──
        def pack_to(bad_tree=None, facts=None):
            out = os.path.join(tmp, "refused.txr")
            _ = pack(bad_tree if bad_tree is not None else tree, facts if facts is not None else facts_path, out)
            assert False, "expected a refusal"

        # symlink in the tree
        link = os.path.join(tree, "model-link.json")
        os.symlink(os.path.join(tree, "model.json"), link)
        _expect_refusal("a symlink in the tree", lambda: pack_to(), "TREE_NON_REGULAR_FILE")
        os.remove(link)
        # fifo in the tree
        fifo = os.path.join(weights, "pipe.bin")
        os.mkfifo(fifo)
        _expect_refusal("a fifo in the tree", lambda: pack_to(), "TREE_NON_REGULAR_FILE")
        os.remove(fifo)
        # a hazard character in a file name
        hazard = os.path.join(weights, "a:b.bin")
        os.rename(os.path.join(weights, "tree-01.bin"), hazard)
        _expect_refusal("a hazard character in a file name", lambda: pack_to(), "TREE_UNSAFE_PATH")
        os.rename(hazard, os.path.join(weights, "tree-01.bin"))
        # an empty tree
        empty = os.path.join(tmp, "empty")
        os.makedirs(empty)
        _expect_refusal("an empty tree", lambda: pack_to(empty), "TREE_EMPTY")
        # a missing tree
        _expect_refusal("a missing tree", lambda: pack_to(os.path.join(tmp, "nope")), "TREE_NOT_DIR")

        # the facts refusals (each removes one required field)
        for key in ("method_id", "method_version", "decision_day", "endpoint", "horizon", "licence"):
            broken = dict(_facts())
            del broken[key]
            broken_path = os.path.join(tmp, "broken.json")
            with open(broken_path, "w", encoding="utf-8") as f:
                json.dump(broken, f)
            _expect_refusal(
                "facts missing %s" % key,
                lambda p=broken_path: pack_to(facts=p),
                "FACTS_MISSING_FIELD",
            )
        broken = dict(_facts())
        del broken["env"]["base_digest"]
        with open(os.path.join(tmp, "broken.json"), "w", encoding="utf-8") as f:
            json.dump(broken, f)
        _expect_refusal(
            "facts missing env.base_digest",
            lambda: pack_to(facts=os.path.join(tmp, "broken.json")),
            "FACTS_MISSING_FIELD",
        )
        for licence in ("", "   "):
            broken = dict(_facts())
            broken["licence"] = licence
            with open(os.path.join(tmp, "broken.json"), "w", encoding="utf-8") as f:
                json.dump(broken, f)
            _expect_refusal(
                "licence %r" % licence,
                lambda: pack_to(facts=os.path.join(tmp, "broken.json")),
                "LICENCE_EMPTY",
            )
        assert not os.path.exists(os.path.join(tmp, "refused.txr")), "a refusal writes nothing"

        # a tampered container fails verify at the entry digest (the last
        # payload byte: 12 end magic + 8 training count + 32 digest before it)
        tampered = bytearray(first)
        tampered[-53] ^= 0x01
        tampered_path = os.path.join(tmp, "tampered.txr")
        with open(tampered_path, "wb") as f:
            f.write(bytes(tampered))
        _expect_refusal(
            "a tampered container",
            lambda: verify_container(tampered_path),
            "VERIFY_ENTRY_DIGEST_MISMATCH",
        )
        vsize, vdigest = verify_container(out1)
        assert (vsize, vdigest) == (size, digest), "verify reports the same size and sha256"
        print("selftest: all checks passed")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ────────────────────────────── main ──────────────────────────────

def main(argv):
    parser = argparse.ArgumentParser(
        prog="pack_model_txr.py",
        description="Deterministic .txr writer for the pretrained model-store container.",
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--tree", metavar="DIR", help="the model tree to pack (opaque bytes)")
    group.add_argument("--verify", metavar="FILE", help="re-open and validate a packed container")
    group.add_argument("--selftest", action="store_true", help="run the unit checks")
    parser.add_argument("--facts", metavar="JSON", help="the model facts file")
    parser.add_argument("--out", metavar="FILE", help="the .txr output path")
    args = parser.parse_args(argv)

    if args.selftest:
        selftest()
        return 0
    if args.verify:
        size, digest = verify_container(args.verify)
        sys.stdout.write("size_bytes: %d\nsha256: %s\n" % (size, digest))
        return 0

    if not args.tree or not args.facts or not args.out:
        parser.error("pack mode requires --tree, --facts and --out")
    size, digest = pack(args.tree, args.facts, args.out)
    sys.stdout.write("size_bytes: %d\nsha256: %s\n" % (size, digest))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except PackError as exc:
        sys.stderr.write("ERROR %s: %s\n" % (exc.code, exc))
        sys.exit(1)
