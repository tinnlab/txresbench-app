#!/usr/bin/env python3
"""Assemble the method list (`method-list.json`): the two method documents in one file.

The list is what a maintainer signs and publishes (`scripts/publish-method-list.sh`) and
what an app release imports as its built-in copy (`scripts/import-method-list.sh`). It
holds the catalogue (`catalogue.json`, schema_version 1) and the environment images
(`method-env-images.json`, schema_version 2) as they are, nested, under a small header:

    { "format": "txresbench-method-list", "format_version": 1, "sequence": 42,
      "assembled_at": "2026-11-20T10:00:00Z",
      "catalogue": { ... }, "images": { ... } }

The DATA lives in the methods repository, folder `method-list/` (the two documents and the
assembled list); this tool lives in the app repository and is pointed at that folder.
Stdlib only.

Modes:
    --list-dir DIR (--previous LIST | --first) [--out FILE]
        Read DIR/catalogue.json and DIR/method-env-images.json and write DIR/method-list.json
        (or FILE) with `sequence` = the previous list's + 1 (`--first`: 1).
    --list-dir DIR --check [--previous LIST]
        Rebuild the list with the header of the committed DIR/method-list.json (format,
        format_version, sequence, assembled_at) and byte-compare: a hand edit, or a
        document changed without a new assembly, fails.
    --bootstrap --catalogue FILE --images FILE --out FILE
        A `sequence: 0` list from an app's current two files (until the first publish
        only; never signed).
    --extract LIST --catalogue-out FILE --images-out FILE
        Write the nested documents with each generator's own writer
        (gen_method_catalogue.py's `dump_to_text`, generate-method-env-images.py's
        `manifest_bytes`): the bytes those generators would have written.
    --diff OLD NEW
        Print what changed between two lists (methods added / changed / retired, image
        entries, bases, sequence old -> new). OLD may be `-` (no previous list).
    --sequence-of LIST
        Print the list's sequence (after the header checks).
    --successor OLD NEW
        Check that NEW may follow OLD: rules 1-2 within NEW, and against OLD rule 3 (no row
        removed) and rule 5 (same version, same run-shaping facts). The import runs it
        against the app's built-in list.

Refusals (exit 1, the code first): LIST_UNKNOWN_METHOD (an image entry with no catalogue
row), LIST_VERSION_MISMATCH (an image entry whose method_version is not its row's
version), LIST_ROW_REMOVED (a row of the previous list is missing: retire a method with
`runnable: false` instead), LIST_FACTS_CHANGED_SAME_VERSION (a run-shaping fact changed
and the version did not), LIST_TOO_LARGE (over 16 MiB), LIST_STALE (`--check`),
LIST_HEADER_INVALID / LIST_PREVIOUS_INVALID / LIST_DOC_INVALID (a file that is not what
it should be). Exit 2 = usage.

Serialization: sorted keys, indent 1, a trailing newline. `assembled_at` comes from
SOURCE_DATE_EPOCH when it is set (reproducible), else the current time.
"""
import argparse
import datetime
import importlib.util
import json
import os
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent

FORMAT = "txresbench-method-list"
FORMAT_VERSION = 1
#: The cap the app enforces too (the fetch kills a pull past it): ~2.9 MB today, ~5 MB with
#: every method on two arches.
MAX_LIST_BYTES = 16 * 1024 * 1024
CATALOGUE_FILE = "catalogue.json"
IMAGES_FILE = "method-env-images.json"
LIST_FILE = "method-list.json"
HEADER_FIELDS = ("format", "format_version", "sequence", "assembled_at", "catalogue", "images")
CATALOGUE_SCHEMA_VERSION = 1
IMAGES_SCHEMA_VERSION = 2

#: Rule 5: the facts that shape a run. They change only with a `version` bump, so "same
#: version = same facts" holds for a saved model that recorded them.
RUN_SHAPING_FACTS = ("markers", "required_markers", "covariates", "min_draws", "needs_baseline",
                     "uses_history", "fitted", "saves_model", "own_outputs", "tasks", "group",
                     "needs_detection_call", "params")


class ListError(Exception):
    def __init__(self, code, message):
        super().__init__(f"{code}: {message}")
        self.code = code


def same(a, b):
    """Equal as JSON, value types included: Python's == takes 0.0 == False, 1 == True and
    150 == 150.0, which are different facts to the app."""
    return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


def _no_duplicate_keys(pairs):
    out = {}
    for k, v in pairs:
        if k in out:
            raise ValueError(f"duplicate key {k!r}")
        out[k] = v
    return out


def load_json(path, code):
    """A JSON file; a key given twice is refused (another reader could take the other value)."""
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f, object_pairs_hook=_no_duplicate_keys)
    except (OSError, ValueError) as e:
        raise ListError(code, f"{path}: {e}") from e


def _load_module(path, name):
    sys.dont_write_bytecode = True  # no __pycache__ next to the generators
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _catalogue_generator():
    return _load_module(SCRIPT_DIR / "method-catalogue" / "gen_method_catalogue.py",
                        "_txr_gen_method_catalogue")


def _images_generator():
    return _load_module(SCRIPT_DIR / "generate-method-env-images.py", "_txr_gen_method_env_images")


def assembled_at():
    epoch = os.environ.get("SOURCE_DATE_EPOCH")
    when = (datetime.datetime.fromtimestamp(int(epoch), datetime.timezone.utc) if epoch
            else datetime.datetime.now(datetime.timezone.utc))
    return when.strftime("%Y-%m-%dT%H:%M:%SZ")


def list_bytes(doc):
    return (json.dumps(doc, indent=1, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8")


def check_docs(catalogue, images):
    """The shape the cross rules need (the full validation is the generators' guards and the
    app's loader): a schema 1 catalogue with methods, a schema 2 images list with envs."""
    if not isinstance(catalogue, dict) or catalogue.get("schema_version") != CATALOGUE_SCHEMA_VERSION:
        raise ListError("LIST_DOC_INVALID", "the catalogue is not a schema_version "
                        f"{CATALOGUE_SCHEMA_VERSION} catalogue")
    if not isinstance(catalogue.get("methods"), list) or not all(
            isinstance(m, dict) and isinstance(m.get("id"), str) for m in catalogue["methods"]):
        raise ListError("LIST_DOC_INVALID", "the catalogue's methods are not rows with an id")
    if not isinstance(images, dict) or images.get("schema_version") != IMAGES_SCHEMA_VERSION:
        raise ListError("LIST_DOC_INVALID", "the images document is not a schema_version "
                        f"{IMAGES_SCHEMA_VERSION} list")
    if not isinstance(images.get("envs"), list) or not all(isinstance(e, dict) for e in images["envs"]):
        raise ListError("LIST_DOC_INVALID", "the images document's envs are not entries")


def check_cross_rules(catalogue, images, previous_catalogue=None):
    """Rules 1-3 and 5 of the plan (PLAN-pr4-5-online-list.md, "Cross-document rules")."""
    check_docs(catalogue, images)
    rows = {m["id"]: m for m in catalogue["methods"]}
    for e in images["envs"]:
        ref = f"{e.get('env_id')}-{e.get('arch')}"
        row = rows.get(e.get("method_id"))
        # Rule 1: every image entry has its catalogue row.
        if row is None:
            raise ListError("LIST_UNKNOWN_METHOD", f"image entry {ref} names method "
                            f"{e.get('method_id')!r}, which has no catalogue row")
        # Rule 2: every arch entry carries the row's version (a version bump rebuilds every
        # listed arch, or drops the stale one).
        if not same(e.get("method_version"), row.get("version")):
            raise ListError("LIST_VERSION_MISMATCH", f"image entry {ref} is version "
                            f"{e.get('method_version')!r}, the catalogue row is "
                            f"{row.get('version')!r}: rebuild every listed arch at the new "
                            "version, or drop the stale entry")
    if previous_catalogue is None:
        return
    for old in previous_catalogue.get("methods") or []:
        new = rows.get(old.get("id"))
        # Rule 3: a row is never removed (saved models and history keep their facts).
        if new is None:
            raise ListError("LIST_ROW_REMOVED", f"method {old.get('id')!r} is in the previous "
                            "list and missing here: a method is retired with "
                            "`runnable: false`, never removed")
        # Rule 5: same version = same run-shaping facts.
        if same(new.get("version"), old.get("version")):
            changed = [f for f in RUN_SHAPING_FACTS if not same(new.get(f), old.get(f))]
            if changed:
                raise ListError("LIST_FACTS_CHANGED_SAME_VERSION",
                                f"method {old.get('id')!r} keeps version "
                                f"{old.get('version')!r} but changes {', '.join(changed)}: "
                                "a run-shaping fact changes only with a version bump")


def check_header(doc, path, code="LIST_HEADER_INVALID"):
    if not isinstance(doc, dict):
        raise ListError(code, f"{path} is not a JSON object")
    missing = [f for f in HEADER_FIELDS if f not in doc]
    extra = sorted(set(doc) - set(HEADER_FIELDS))
    if missing or extra:
        raise ListError(code, f"{path}: header fields missing {missing} / unknown {extra}")
    if doc["format"] != FORMAT:
        raise ListError(code, f"{path}: format {doc['format']!r} is not {FORMAT!r}")
    if doc["format_version"] != FORMAT_VERSION or isinstance(doc["format_version"], bool):
        raise ListError(code, f"{path}: format_version {doc['format_version']!r} is not "
                        f"{FORMAT_VERSION} (a new format version is a new tag line, v2)")
    seq = doc["sequence"]
    if not isinstance(seq, int) or isinstance(seq, bool) or seq < 0:
        raise ListError(code, f"{path}: sequence {seq!r} is not a whole number >= 0")
    if not isinstance(doc["assembled_at"], str):
        raise ListError(code, f"{path}: assembled_at is not a string")
    return doc


def load_list(path, code="LIST_HEADER_INVALID"):
    return check_header(load_json(path, code), path, code)


def build(catalogue, images, *, sequence, when, previous_catalogue=None):
    check_cross_rules(catalogue, images, previous_catalogue)
    doc = {"format": FORMAT, "format_version": FORMAT_VERSION, "sequence": sequence,
           "assembled_at": when, "catalogue": catalogue, "images": images}
    data = list_bytes(doc)
    if len(data) > MAX_LIST_BYTES:
        raise ListError("LIST_TOO_LARGE", f"the list is {len(data)} bytes, over the "
                        f"{MAX_LIST_BYTES}-byte cap the app enforces")
    return data


def read_list_dir(list_dir):
    d = Path(list_dir)
    return (load_json(d / CATALOGUE_FILE, "LIST_DOC_INVALID"),
            load_json(d / IMAGES_FILE, "LIST_DOC_INVALID"))


def first_difference(a, b, path="$"):
    def number(v):
        return isinstance(v, (int, float)) and not isinstance(v, bool)
    if number(a) and number(b):
        return None if a == b else path  # 0 and 0.0: a layout difference, not a value
    if type(a) is not type(b):
        return path
    if isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a or k not in b:
                return f"{path}.{k}"
            d = first_difference(a[k], b[k], f"{path}.{k}")
            if d:
                return d
        return None
    if isinstance(a, list):
        for i, (x, y) in enumerate(zip(a, b)):
            d = first_difference(x, y, f"{path}[{i}]")
            if d:
                return d
        return None if len(a) == len(b) else f"{path}[{min(len(a), len(b))}]"
    return None if a == b else path


def write_atomic(path, data):
    path = Path(path)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def cmd_assemble(a):
    catalogue, images = read_list_dir(a.list_dir)
    previous_catalogue = None
    if a.first:
        sequence = 1
    else:
        prev = load_list(a.previous, "LIST_PREVIOUS_INVALID")
        sequence = prev["sequence"] + 1
        previous_catalogue = prev["catalogue"]
    data = build(catalogue, images, sequence=sequence, when=assembled_at(),
                 previous_catalogue=previous_catalogue)
    out = Path(a.out) if a.out else Path(a.list_dir) / LIST_FILE
    write_atomic(out, data)
    print(f"assemble-method-list: wrote {out}: sequence {sequence}, "
          f"{len(catalogue['methods'])} methods, {len(images['envs'])} image entries, "
          f"{len(data)} bytes")
    return 0


def cmd_check(a):
    committed_path = Path(a.list_dir) / LIST_FILE
    try:
        committed_bytes = committed_path.read_bytes()
    except OSError as e:
        raise ListError("LIST_STALE", f"{committed_path}: {e} (assemble the list first)") from e
    committed = load_list(committed_path)
    catalogue, images = read_list_dir(a.list_dir)
    previous_catalogue = None
    if a.previous:
        prev = load_list(a.previous, "LIST_PREVIOUS_INVALID")
        if committed["sequence"] <= prev["sequence"]:
            raise ListError("LIST_STALE", f"{committed_path}: sequence {committed['sequence']} "
                            f"is not above the previous list's {prev['sequence']}")
        previous_catalogue = prev["catalogue"]
    data = build(catalogue, images, sequence=committed["sequence"],
                 when=committed["assembled_at"], previous_catalogue=previous_catalogue)
    if data != committed_bytes:
        where = first_difference(json.loads(committed_bytes), json.loads(data)) or "(layout)"
        raise ListError("LIST_STALE", f"{committed_path} is not the assembly of "
                        f"{CATALOGUE_FILE} + {IMAGES_FILE} (first difference at {where}): "
                        "re-run the assembler, never edit the list by hand")
    print(f"assemble-method-list: {committed_path} matches its assembly "
          f"(sequence {committed['sequence']})")
    return 0


def cmd_bootstrap(a):
    catalogue = load_json(a.catalogue, "LIST_DOC_INVALID")
    images = load_json(a.images, "LIST_DOC_INVALID")
    data = build(catalogue, images, sequence=0, when=assembled_at())
    write_atomic(a.out, data)
    print(f"assemble-method-list: wrote {a.out}: sequence 0 (bootstrap, unsigned), "
          f"{len(catalogue['methods'])} methods, {len(images['envs'])} image entries")
    return 0


def catalogue_bytes(catalogue):
    """gen_method_catalogue.py's own writer (sorted keys, indent 1, hygiene scan)."""
    return _catalogue_generator().dump_to_text(catalogue).encode("utf-8")


def images_bytes(images):
    """generate-method-env-images.py's own writer: indent 2, the schema's field order. A
    list without `bases` stays without it; an entry with other fields than the schema's is
    refused (it would be dropped silently)."""
    gen = _images_generator()
    top = ("schema_version", "generator_version", "base_contract", "bases", "envs")
    extra = sorted(set(images) - set(top))
    if extra:
        raise ListError("LIST_DOC_INVALID", f"the images document has unknown fields {extra}")
    out = {k: images[k] for k in top if k in images and k not in ("bases", "envs")}
    if "bases" in images:
        for b in images["bases"]:
            if set(b) != set(gen.BASE_ENTRY_FIELDS):
                raise ListError("LIST_DOC_INVALID", f"base {b.get('base_id')}-{b.get('arch')} "
                                "does not carry exactly the schema's base fields")
        out["bases"] = [{f: b[f] for f in gen.BASE_ENTRY_FIELDS} for b in images["bases"]]
    for e in images["envs"]:
        if set(e) != set(gen.ENV_FIELDS):
            raise ListError("LIST_DOC_INVALID", f"image entry {e.get('env_id')}-{e.get('arch')} "
                            "does not carry exactly the schema's entry fields")
    out["envs"] = [{f: e[f] for f in gen.ENV_FIELDS} for e in images["envs"]]
    return gen.manifest_bytes(out)


def cmd_extract(a):
    doc = load_list(a.extract)
    check_cross_rules(doc["catalogue"], doc["images"])
    cat, img = catalogue_bytes(doc["catalogue"]), images_bytes(doc["images"])
    write_atomic(a.catalogue_out, cat)
    write_atomic(a.images_out, img)
    print(f"assemble-method-list: extracted sequence {doc['sequence']}: {a.catalogue_out} "
          f"({len(cat)} bytes), {a.images_out} ({len(img)} bytes)")
    return 0


def _rows(doc):
    return {m["id"]: m for m in (doc or {}).get("catalogue", {}).get("methods", [])}


def _entries(doc, field="envs", key=("env_id", "arch")):
    return {f"{e[key[0]]}-{e[key[1]]}": e for e in (doc or {}).get("images", {}).get(field) or []}


def diff_lines(old, new):
    lines = [f"sequence: {old['sequence'] if old else '(none)'} -> {new['sequence']}"]
    o_rows, n_rows = _rows(old), _rows(new)
    added = sorted(set(n_rows) - set(o_rows))
    changed = sorted(i for i in set(n_rows) & set(o_rows) if n_rows[i] != o_rows[i])
    retired = sorted(i for i in changed if o_rows[i].get("runnable") and not n_rows[i].get("runnable"))
    lines.append(f"methods added ({len(added)}): "
                 + (", ".join(f"{i} {n_rows[i].get('version')}" for i in added) or "none"))
    lines.append(f"methods changed ({len(changed) - len(retired)}): " + (", ".join(
        f"{i} {o_rows[i].get('version')} -> {n_rows[i].get('version')}"
        for i in changed if i not in retired) or "none"))
    lines.append(f"methods retired ({len(retired)}): " + (", ".join(retired) or "none"))
    removed = sorted(set(o_rows) - set(n_rows))
    if removed:
        lines.append(f"methods REMOVED ({len(removed)}): " + ", ".join(removed))
    for label, field, key in (("image entries", "envs", ("env_id", "arch")),
                              ("bases", "bases", ("base_id", "arch"))):
        o, n = _entries(old, field, key), _entries(new, field, key)
        add = sorted(set(n) - set(o))
        rem = sorted(set(o) - set(n))
        chg = sorted(k for k in set(n) & set(o) if n[k] != o[k])
        chg_text = ", ".join("%s (%s -> %s)" % (k, o[k].get("tag"), n[k].get("tag")) for k in chg)
        lines.append("%s: added %s; changed %s; removed %s"
                     % (label, ", ".join(add) or "none", chg_text or "none",
                        ", ".join(rem) or "none"))
    return lines


def cmd_diff(a):
    old = None if a.diff[0] == "-" else load_list(a.diff[0])
    new = load_list(a.diff[1])
    for line in diff_lines(old, new):
        print(line)
    return 0


def cmd_successor(a):
    old, new = load_list(a.successor[0]), load_list(a.successor[1])
    check_cross_rules(new["catalogue"], new["images"], previous_catalogue=old["catalogue"])
    print(f"assemble-method-list: sequence {new['sequence']} keeps the rows and facts of "
          f"sequence {old['sequence']}")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="Assemble, check, extract or compare the method list "
                                             "(method-list.json).")
    ap.add_argument("--list-dir", metavar="DIR", help="the methods repository's method-list/ folder")
    ap.add_argument("--previous", metavar="LIST", help="the previous method-list.json")
    ap.add_argument("--first", action="store_true", help="the first list: sequence 1, no previous")
    ap.add_argument("--out", metavar="FILE", help="where to write (default DIR/method-list.json)")
    ap.add_argument("--check", action="store_true", help="rebuild with the committed header and "
                                                         "byte-compare")
    ap.add_argument("--bootstrap", action="store_true", help="a sequence 0 list from --catalogue "
                                                             "and --images")
    ap.add_argument("--catalogue", metavar="FILE")
    ap.add_argument("--images", metavar="FILE")
    ap.add_argument("--extract", metavar="LIST", help="write the nested documents of LIST")
    ap.add_argument("--catalogue-out", metavar="FILE")
    ap.add_argument("--images-out", metavar="FILE")
    ap.add_argument("--diff", nargs=2, metavar=("OLD", "NEW"))
    ap.add_argument("--sequence-of", metavar="LIST")
    ap.add_argument("--successor", nargs=2, metavar=("OLD", "NEW"))
    a = ap.parse_args(argv)

    modes = [bool(a.check), bool(a.bootstrap), bool(a.extract), bool(a.diff), bool(a.sequence_of),
             bool(a.successor)]
    if sum(modes) > 1:
        ap.error("--check, --bootstrap, --extract, --diff, --sequence-of and --successor are "
                 "separate runs")
    try:
        if a.successor:
            return cmd_successor(a)
        if a.sequence_of:
            print(load_list(a.sequence_of)["sequence"])
            return 0
        if a.diff:
            return cmd_diff(a)
        if a.extract:
            if not (a.catalogue_out and a.images_out):
                ap.error("--extract needs --catalogue-out and --images-out")
            return cmd_extract(a)
        if a.bootstrap:
            if not (a.catalogue and a.images and a.out):
                ap.error("--bootstrap needs --catalogue, --images and --out")
            return cmd_bootstrap(a)
        if not a.list_dir:
            ap.error("--list-dir is required (the methods repository's method-list/ folder)")
        if a.check:
            if a.first:
                ap.error("--check reads the committed header; --first is for a new list")
            return cmd_check(a)
        if bool(a.previous) == bool(a.first):
            ap.error("LIST_SEQUENCE: pass --previous <the previous method-list.json> (sequence + 1) "
                     "or --first (sequence 1), exactly one")
        return cmd_assemble(a)
    except ListError as e:
        print(f"assemble-method-list: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
