#!/usr/bin/env python3
"""Build the TxResBench app's pretrained-model catalogue (pretrained-catalogue node, generator part).

Reads the curated enrollment (`models-manifest.tsv`), the curated assay warnings
(`assay-warnings.tsv`), the method facts this node's sisters already produce
(`data/method-catalogue/catalogue.json` — PROV-MC-1, the same file CONS-PC-2
binds for boot validation: one fact assembly, so a pretrained card's `needs`
and the method card's facts can never disagree), the environment-image manifest
(`src-app/server/data/method-env-images.json` — PROV-method-env-images-1; the
env digests recorded on the card, INV-7), and the BENCHMARK facts at BUILD time
only (CONS-PC-9, through SIGTRANS_ROOT): `dev/code/manifest/methods.csv` (the
frozen+container+gate-pass selection and the paper block),
`dev/code/manifest/datasets.csv` + `dev/code/datasets/<id>/dataset.yaml` (the
restricted-data gate + card licence, DEC-8/9), and
`results/benchmark/scores.csv` (the per-cohort `transfer` aggregates). Nothing
is read at run time (INV-8).

Outputs (PROV-PC-1): `data/pretrained-catalogue/catalogue.json` (the embedded
snapshot), `data/pretrained-catalogue/bundled-models.json` (the installer
extract: exactly the `asset` fields of the bundled entries) and
`site/public/pretrained-catalogue.json` (byte-identical to the snapshot — the
served copy, PROV-landing-site-2).

Usage:
    python3 scripts/pretrained-catalogue/gen_pretrained_catalogue.py
        [--out data/pretrained-catalogue/catalogue.json]
        [--bundled-out data/pretrained-catalogue/bundled-models.json]
        [--site-out site/public/pretrained-catalogue.json]
        --fixtures        read the synthetic fixture registry
                          (scripts/pretrained-catalogue/fixtures/gen/) instead
                          of SIGTRANS_ROOT; deterministic commits + generated_at
        --check           regenerate and compare with the targets; exit 1 on a
                          mismatch (fixture mode: byte-exact against
                          fixtures/gen/expected-*.json; real mode: data equality
                          with generated_at neutralized)
        --check-restricted
                          run the entry gate (access classes, licences, sha256
                          format, GENIE pattern, frozen+container+gate, env
                          entry, asset immutability) and exit 0/1; writes nothing
        --selftest        run the generator's own invariant checks
                          (TEST-PC-12/16's matrix) against the fixtures
        --manifest / --warnings / --method-catalogue / --env-images
                          override the curated input paths
        SIGTRANS_ROOT     environment override for the benchmark tree
                          (default /data/share/pbya/sigtrans)
        SOURCE_DATE_EPOCH timestamp override for generated_at (reproducible)

Reproducibility: no network, no machine paths, deterministic output under
SOURCE_DATE_EPOCH. Hygiene: every curated text string is passed through the
sanitizers (URLs removed, case-insensitive `stud(y|ies)` replaced, status
tokens neutralized) and the final document is re-scanned — any `http(s)://`
host outside {github.com, tinnlab.github.io}, residual `stud(y|ies)` token or
status/progress/placeholder token aborts the run with a named error, never
silently shipped.

Note on vocabulary: the CONTAINER header's `task` (packer facts) is the outcome
flavor (`pfs` | `os` | `response`), while the CARD's `needs.task` is the task
class (`survival` | `response` | null). They are different fields; the facts
cross-check pins the mapping (a survival card's header task is its endpoint).
"""
import argparse
import collections
import csv
import datetime
import json
import math
import os
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
FIXTURE_DIR = SCRIPT_DIR / "fixtures" / "gen"

DEFAULT_MANIFEST = SCRIPT_DIR / "models-manifest.tsv"
DEFAULT_WARNINGS = SCRIPT_DIR / "assay-warnings.tsv"
DEFAULT_METHOD_CATALOGUE = REPO_ROOT / "data" / "method-catalogue" / "catalogue.json"
DEFAULT_ENV_IMAGES = REPO_ROOT / "src-app" / "server" / "data" / "method-env-images.json"
DEFAULT_CATALOGUE = REPO_ROOT / "data" / "pretrained-catalogue" / "catalogue.json"
DEFAULT_BUNDLED = REPO_ROOT / "data" / "pretrained-catalogue" / "bundled-models.json"
DEFAULT_SITE_FILE = REPO_ROOT / "site" / "public" / "pretrained-catalogue.json"
FIXTURE_EXPECTATION = FIXTURE_DIR / "expected-catalogue.json"
FIXTURE_EXPECTATION_BUNDLED = FIXTURE_DIR / "expected-bundled-models.json"
FIXTURE_SITE_OUT = FIXTURE_DIR / "expected-site-catalogue.json"
DEFAULT_SIGTRANS_ROOT = Path("/data/share/pbya/sigtrans")
FIXTURE_EPOCH = 1767225600  # 2026-01-01T00:00:00Z — deterministic fixture provenance

SCHEMA_VERSION = 1
MODELS_REPO = "tinnlab/txresbench-models"
ALLOWED_HOSTS = {"github.com", "tinnlab.github.io"}  # PROV-landing-site-2 host policy
MAX_BUNDLED_BYTES = 20 * 1024 * 1024  # DEC-5 default bundle cap
PACKER = SCRIPT_DIR / "pack_model_txr.py"

KINDS = ("published-rule", "benchmark-trained")
TASK_CLASSES = ("survival", "response")
ENDPOINTS = ("pfs", "os")
TRANSFER_METRICS = ("auc_rule", "c_index")
# the restricted-data guard's GENIE record-id pattern (check_restricted.py)
GENIE_ID = re.compile(r"\bGENIE-[A-Z]{2,6}-\d{3,}\b")
ID_SLUG = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
ASSET_VERSION = re.compile(r"^\d+\.\d+\.\d+$")
SHA256_HEX = re.compile(r"^[0-9a-f]{64}$")
USES_HISTORY_VALUES = ("landmark", "full")  # the container's vocabulary

GROUP_LABELS = {
    "response-call": "Response call",
    "response-probability": "Response probability",
    "static-risk": "Static risk",
    "dynamic-risk": "Dynamic risk",
}


class Refusal(Exception):
    """A named build gate refusal — printed `ERROR <code>: <id>: <detail>`."""

    def __init__(self, code, id_, detail):
        super().__init__("%s: %s: %s" % (code, id_, detail))
        self.code = code
        self.id = id_
        self.detail = detail


# ---- sanitizers (the method-catalogue hygiene discipline, INV-5) ----
_URL_RE = re.compile(r"https?://\S+", re.I)
_STUD_RE = re.compile(r"\bstud(?:ies|y)\b", re.I)
_STATUS_RE = re.compile(r"\bplaceholder\b|\bin\s+progress\b|\b(?:todo|fixme|wip)\b", re.I)


def _status_sub(m):
    word = m.group(0).lower()
    if word == "placeholder":
        return "blank"
    if word == "in progress":
        return "under way"
    return ""


def sanitize_string(s):
    s = _URL_RE.sub("", s)
    s = _STUD_RE.sub(lambda m: "Research" if m.group(0)[0].isupper() else "research", s)
    s = _STATUS_RE.sub(_status_sub, s)
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\(\s+", "(", s)
    s = re.sub(r"\s+\)", ")", s)
    s = re.sub(r"\(\s*\)", "", s)
    s = re.sub(r"\s+([,.;:!?])", r"\1", s)
    s = re.sub(r"^[,.;:!?]+", "", s)
    return s.strip()


def host_of(url):
    m = re.match(r"https?://([^/?#]+)", url)
    return m.group(1) if m else None


def hygiene_scan(value, where="."):
    """Hygiene violations in a value tree: hosts outside the policy, stud
    tokens, status/placeholder tokens."""
    hits = []
    if isinstance(value, str):
        for m in _URL_RE.finditer(value):
            host = host_of(m.group(0))
            if host not in ALLOWED_HOSTS:
                hits.append(f"{where}: host {host!r} outside {sorted(ALLOWED_HOSTS)}")
        for m in _STUD_RE.finditer(value):
            hits.append(f"{where}: 'stud(y|ies)' token")
        for m in _STATUS_RE.finditer(value):
            hits.append(f"{where}: status/placeholder token")
    elif isinstance(value, list):
        for i, x in enumerate(value):
            hits.extend(hygiene_scan(x, f"{where}[{i}]"))
    elif isinstance(value, dict):
        for k, x in value.items():
            hits.extend(hygiene_scan(x, f"{where}.{k}"))
    return hits


# ---- curated TSV loaders ----
def load_manifest(path):
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) < 21:
                raise ValueError(f"{path}: malformed manifest row ({len(parts)} fields): {line[:80]!r}")
            rows.append({
                "id": parts[0].strip(),
                "version": parts[1].strip(),
                "kind": parts[2].strip(),
                "method_id": parts[3].strip(),
                "tag": parts[4].strip(),
                "file": parts[5].strip(),
                "sha256": parts[6].strip(),
                "size_bytes": parts[7].strip(),
                "bundled": parts[8].strip(),
                "sources": parts[9].strip(),
                "licence": parts[10].strip(),
                "tree": parts[11].strip(),
                "facts": parts[12].strip(),
                "name": parts[13].strip(),
                "description": parts[14].strip(),
                "citation": parts[15].strip(),
                "decision_day": parts[16].strip(),
                "endpoint": parts[17].strip(),
                "horizon": parts[18].strip(),
                "task": parts[19].strip(),
                "transfer_metric": parts[20].strip(),
            })
    return rows


def load_warnings(path):
    """method_id -> [(code, detail)] in file order."""
    out = collections.OrderedDict()
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) < 3:
                raise ValueError(f"{path}: malformed warning row: {line[:80]!r}")
            out.setdefault(parts[0].strip(), []).append(
                (parts[1].strip(), parts[2].strip()))
    return out


# ---- registry loaders (CONS-PC-9 + PROV-MC-1 + PROV-method-env-images-1) ----
def load_method_catalogue(path):
    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(doc, dict) or not isinstance(doc.get("methods"), list):
        raise ValueError(f"{path}: not a method catalogue document")
    return {m["id"]: m for m in doc["methods"] if m.get("id")}


def load_env_images(path):
    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(doc, dict) or not isinstance(doc.get("envs"), list):
        raise ValueError(f"{path}: not an env-images manifest")
    return {e["env_id"]: e for e in doc["envs"] if e.get("env_id")}


def load_registry_manifest(path):
    with open(path, newline="", encoding="utf-8") as f:
        return {r["method"]: r for r in csv.DictReader(f) if r.get("method")}


def _yaml_load(path):
    try:
        import yaml
    except ImportError:
        raise RuntimeError("PyYAML is required to read dataset.yaml files (pip install pyyaml)")
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def load_dataset_registry(root):
    """{dataset_id: {access, licence}} over datasets.csv membership + dataset.yaml facts."""
    datasets_csv = root / "dev" / "code" / "manifest" / "datasets.csv"
    datasets_dir = root / "dev" / "code" / "datasets"
    if not datasets_csv.exists() or not datasets_dir.exists():
        raise FileNotFoundError(f"dataset registry missing: {datasets_csv} / {datasets_dir}")
    ids = []
    with open(datasets_csv, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if r.get("dataset"):
                ids.append(r["dataset"])
    registry = {}
    for dataset in ids:
        yaml_path = datasets_dir / dataset / "dataset.yaml"
        facts = {}
        if yaml_path.exists():
            doc = _yaml_load(yaml_path)
            if isinstance(doc, dict):
                facts = doc
        registry[dataset] = {
            "access": str(facts.get("access") or "").strip(),
            "licence": str(facts.get("licence") or "").strip(),
        }
    return registry


def load_scores(root, method_ids, metric):
    """per method per dataset -> [values] over primary rows of one metric (CONS-PC-9)."""
    if not method_ids:
        return {}
    scores_csv = root / "results" / "benchmark" / "scores.csv"
    if not scores_csv.exists():
        raise FileNotFoundError(f"{scores_csv}: benchmark scores missing")
    out = collections.defaultdict(lambda: collections.defaultdict(list))
    with open(scores_csv, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if r.get("metric") != metric or str(r.get("primary")).lower() != "true":
                continue
            if r.get("method") not in method_ids:
                continue
            try:
                v = float(r.get("value"))
            except (TypeError, ValueError):
                continue
            out[r["method"]][r.get("dataset") or ""].append(v)
    return out


def git_head(repo):
    try:
        return subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True,
                              text=True, check=True, timeout=30).stdout.strip()
    except Exception:
        return ""


def _iso_time(epoch):
    return datetime.datetime.fromtimestamp(epoch, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---- per-entry assembly + gate ----
def _num_field(row, key, code):
    try:
        v = float(row[key])
    except (TypeError, ValueError):
        raise Refusal(code, row["id"], f"{key} is not a number: {row[key]!r}")
    if not math.isfinite(v) or v <= 0:
        raise Refusal(code, row["id"], f"{key} must be a positive finite number: {row[key]!r}")
    return v


def _resolve_sources(row, datasets):
    """data_sources list + the gateway refusals (DEC-8): controlled access,
    undeclared sources, GENIE record-id pattern, empty source licence."""
    sources = []
    for token in row["sources"].split(";"):
        token = token.strip()
        if not token:
            continue
        parts = [p.strip() for p in token.split("|")]
        if len(parts) == 1:  # a registry dataset id
            name = parts[0]
            if GENIE_ID.search(name):
                raise Refusal("SOURCE_GENIE", row["id"],
                              f"source {name!r} matches the restricted-data record-id pattern")
            facts = datasets.get(name)
            if not facts:
                raise Refusal("SOURCE_UNDECLARED", row["id"],
                              f"source {name!r} is not in the dataset registry")
            if not facts["access"]:
                raise Refusal("SOURCE_UNDECLARED", row["id"],
                              f"source {name!r} declares no access class")
            if facts["access"].lower() == "controlled":
                raise Refusal("ACCESS_CONTROLLED", row["id"],
                              f"source {name!r} is controlled-access data")
            if facts["access"].lower() != "open":
                raise Refusal("SOURCE_UNDECLARED", row["id"],
                              f"source {name!r} access class {facts['access']!r} is not open|controlled")
            if not facts["licence"]:
                raise Refusal("LICENCE_EMPTY", row["id"],
                              f"source {name!r} has an empty licence")
            sources.append({"dataset": name, "access": "open",
                            "licence": sanitize_string(facts["licence"])})
        elif len(parts) == 3:  # curated inline paper-cohort source: name|access|licence
            name, access, licence = parts
            if not name:
                raise Refusal("SOURCE_UNDECLARED", row["id"], "an inline source names nothing")
            if GENIE_ID.search(name):
                raise Refusal("SOURCE_GENIE", row["id"],
                              f"source {name!r} matches the restricted-data record-id pattern")
            if not access:
                raise Refusal("SOURCE_UNDECLARED", row["id"],
                              f"source {name!r} declares no access class")
            if access.lower() not in ("open", "controlled"):
                raise Refusal("SOURCE_UNDECLARED", row["id"],
                              f"source {name!r} access class {access!r} is not open|controlled")
            if access.lower() == "controlled":
                raise Refusal("ACCESS_CONTROLLED", row["id"],
                              f"source {name!r} is controlled-access data")
            if not licence:
                raise Refusal("LICENCE_EMPTY", row["id"], f"source {name!r} has an empty licence")
            sources.append({"dataset": sanitize_string(name), "access": "open",
                            "licence": sanitize_string(licence)})
        else:
            raise Refusal("SOURCE_UNDECLARED", row["id"],
                          f"a source token is malformed: {token!r}")
    if not sources:
        raise Refusal("SOURCE_UNDECLARED", row["id"], "no data sources declared")
    return sources


def _entry_licence(row, sources):
    declared = row["licence"]
    if declared:
        return sanitize_string(declared)
    return "; ".join(sorted({s["licence"] for s in sources}))


def _transfer(row, scores):
    """The 'results on other cohorts' aggregate (CONS-PC-9): per dataset over
    the primary rows of the curated metric; null when absent."""
    metric = row["transfer_metric"]
    if not metric:
        return None
    slots = scores.get(row["method_id"])
    if not slots:
        return None
    cohorts = []
    for dataset in sorted(slots):
        values = slots[dataset]
        if not values:
            continue
        # six decimals: the wire format stays float-stable across medians
        cohorts.append({"dataset": dataset, "value": round(float(statistics.median(values)), 6)})
    if not cohorts:
        return None
    values = [c["value"] for c in cohorts]
    return {"metric": metric, "median": round(float(statistics.median(values)), 6),
            "n_cohorts": len(cohorts), "cohorts": cohorts}


def _facts_crosscheck(row, entry_headline, facts, env):
    """The packer facts are the container header's source; the card records the
    same facts (INV-7: recorded from the asset's header, never re-derived)."""
    def same(key, actual, expected):
        if actual != expected:
            raise Refusal("ASSET_FACTS_MISMATCH", row["id"],
                          f"facts.json {key} {actual!r} != the card {expected!r}")

    if not isinstance(facts, dict):
        raise Refusal("ASSET_FACTS_MISMATCH", row["id"], "facts.json is not an object")
    same("method_id", facts.get("method_id"), entry_headline["method_id"])
    same("catalogue_id", facts.get("catalogue_id"), entry_headline["id"])
    same("licence", facts.get("licence"), entry_headline["licence"])
    same("decision_day", facts.get("decision_day"), entry_headline["decision_day"])
    same("endpoint", facts.get("endpoint"), entry_headline["endpoint"])
    same("horizon", facts.get("horizon"), entry_headline["horizon"])
    task = entry_headline["task"]
    fact_task = facts.get("task")
    if task == "response":
        if fact_task != "response":
            raise Refusal("ASSET_FACTS_MISMATCH", row["id"],
                          f"facts.json task {fact_task!r} != 'response' for the card's response task")
    else:  # survival card: the header task is the outcome flavor (pfs|os)
        if fact_task not in ("pfs", "os"):
            raise Refusal("ASSET_FACTS_MISMATCH", row["id"],
                          f"facts.json task {fact_task!r} is not a survival outcome flavor")
    if (facts.get("env") or {}).get("base_digest") != env["base_digest"]:
        raise Refusal("ASSET_FACTS_MISMATCH", row["id"],
                      "facts.json env.base_digest != the env-images manifest's base_digest")
    if (facts.get("env") or {}).get("layer_digest") != env["layer_digest"]:
        raise Refusal("ASSET_FACTS_MISMATCH", row["id"],
                      "facts.json env.layer_digest != the env-images manifest's layer_sha256")


def build_entry(row, ctx):
    """One manifest row -> the card entry, through the full gate. Refuses with
    a named code on the first violation (deterministic order)."""
    entry_id = row["id"]
    if not ID_SLUG.match(entry_id):
        raise Refusal("ID_INVALID", entry_id, f"{entry_id!r} is not a valid catalogue slug")
    if row["kind"] not in KINDS:
        raise Refusal("KIND_INVALID", entry_id, f"kind {row['kind']!r} is not one of {KINDS}")
    if not ASSET_VERSION.match(row["version"]):
        raise Refusal("ASSET_VERSION_SEMVER", entry_id, f"version {row['version']!r} is not semver")
    if row["file"] != f"{entry_id}@{row['version']}.txr":
        raise Refusal("ASSET_FILE_NAME", entry_id,
                      f"the asset file must be <id>@<version>.txr: {row['file']!r}")
    if not row["tag"]:
        raise Refusal("ASSET_TAG_EMPTY", entry_id, "the release tag is empty")
    if not SHA256_HEX.match(row["sha256"]):
        raise Refusal("ASSET_SHA256_FORMAT", entry_id,
                      f"{row['sha256']!r} is not 64 lowercase hex")
    try:
        size_bytes = int(row["size_bytes"])
    except (TypeError, ValueError):
        raise Refusal("ASSET_SIZE_INVALID", entry_id,
                      f"size_bytes {row['size_bytes']!r} is not an integer")
    if size_bytes <= 0:
        raise Refusal("ASSET_SIZE_INVALID", entry_id, f"size_bytes must be > 0: {size_bytes}")
    bundled_raw = row["bundled"]
    if bundled_raw == "":
        bundled = size_bytes <= MAX_BUNDLED_BYTES
    elif bundled_raw.lower() in ("true", "1", "yes"):
        bundled = True
    elif bundled_raw.lower() in ("false", "0", "no"):
        bundled = False
    else:
        raise Refusal("ASSET_BUNDLED_INVALID", entry_id,
                      f"bundled {bundled_raw!r} is not true|false|empty")
    url = f"https://github.com/{MODELS_REPO}/releases/download/{row['tag']}/{row['file']}"

    if row["transfer_metric"] and row["transfer_metric"] not in TRANSFER_METRICS:
        raise Refusal("TRANSFER_METRIC_INVALID", entry_id,
                      f"transfer_metric {row['transfer_metric']!r} is not one of {TRANSFER_METRICS}")
    if row["task"] and row["task"] not in TASK_CLASSES:
        raise Refusal("TASK_INVALID", entry_id, f"task {row['task']!r} is not one of {TASK_CLASSES}")
    if row["endpoint"] not in ENDPOINTS:
        raise Refusal("ENDPOINT_INVALID", entry_id, f"endpoint {row['endpoint']!r} is not one of {ENDPOINTS}")
    decision_day = _num_field(row, "decision_day", "DECISION_DAY_INVALID")
    horizon = _num_field(row, "horizon", "HORIZON_INVALID")

    sources = _resolve_sources(row, ctx["datasets"])
    licence = _entry_licence(row, sources)
    if not licence:
        raise Refusal("LICENCE_EMPTY", entry_id, "the entry licence is empty after trimming")

    # the published-rule selection (DEC-1): frozen + container + gate-pass in
    # the benchmark registry at generation time (PROV-PC-1's acceptance)
    if row["kind"] == "published-rule":
        reg = ctx["registry"].get(row["method_id"])
        if reg is None:
            raise Refusal("PUBLISHED_RULE_NOT_FROZEN", entry_id,
                          f"method {row['method_id']!r} is not in the benchmark registry")
        for col, want in (("frozen_model", "true"), ("container", "true"), ("gate", "PASS")):
            got = str(reg.get(col) or "").strip().lower()
            if got != want.lower():
                raise Refusal("PUBLISHED_RULE_NOT_FROZEN", entry_id,
                              f"method {row['method_id']!r} registry {col} is {got!r}, expected {want!r}")

    method = ctx["methods"].get(row["method_id"])
    if method is None:
        raise Refusal("METHOD_UNKNOWN", entry_id,
                      f"method {row['method_id']!r} has no method-catalogue entry")
    env_entry = ctx["envs"].get(row["method_id"])
    if env_entry is None:
        raise Refusal("ENV_ENTRY_MISSING", entry_id,
                      f"method {row['method_id']!r} has no method-env-images entry")
    env = {"base_digest": str(env_entry.get("base_digest") or ""),
           "layer_digest": str(env_entry.get("layer_sha256") or "")}
    if not env["base_digest"] or not env["layer_digest"]:
        raise Refusal("ENV_ENTRY_MISSING", entry_id,
                      f"method {row['method_id']!r} env entry lacks base_digest/layer_sha256")

    # asset immutability (TEST-PC-16): a changed sha256/size under the same
    # id+version is a publish error; a new version is the only update path.
    prev = ctx["previous"].get((entry_id, row["version"]))
    if prev is not None:
        if prev.get("sha256") != row["sha256"] or prev.get("size_bytes") != size_bytes:
            raise Refusal("ASSET_CHANGED_UNDER_VERSION", entry_id,
                          f"asset {entry_id}@{row['version']} changed (sha256/size) under its version")

    # where the packer inputs are in-tree (the fixtures; the owner's publish
    # workspace in real runs), the packed bytes are the acceptance: the packer
    # output must equal the manifest's recorded values, and the facts the card
    # records must be the facts the header carries.
    headline = {"method_id": row["method_id"], "id": entry_id, "licence": licence,
                "decision_day": decision_day, "endpoint": row["endpoint"],
                "horizon": horizon, "task": row["task"] or None}
    if row["tree"] and row["facts"]:
        def _asset_path(rel):
            p = Path(rel)
            if p.is_absolute():
                return p
            for base in (ctx["root"], SCRIPT_DIR):
                candidate = base / rel
                if candidate.exists():
                    return candidate
            return Path(rel)

        tree = _asset_path(row["tree"])
        facts_path = _asset_path(row["facts"])
        if not tree.is_dir() or not facts_path.is_file():
            raise Refusal("ASSET_PACK_FAILED", entry_id,
                          f"packer inputs missing: {tree} / {facts_path}")
        tmp = Path(tempfile.mkdtemp(prefix="gen-pretrained-",
                                    dir=os.environ.get("TMPDIR") or tempfile.gettempdir()))
        try:
            out_path = tmp / "asset.txr"
            proc = subprocess.run(
                [sys.executable, str(PACKER), "--tree", str(tree), "--facts", str(facts_path),
                 "--out", str(out_path)],
                capture_output=True, text=True, timeout=600)
            if proc.returncode != 0:
                raise Refusal("ASSET_PACK_FAILED", entry_id,
                              "packer refused: " + (proc.stderr.strip().splitlines() or ["?"])[-1])
            parsed = {}
            for line in proc.stdout.splitlines():
                key, _, value = line.partition(":")
                parsed[key.strip()] = value.strip()
            if parsed.get("sha256") != row["sha256"] or parsed.get("size_bytes") != str(size_bytes):
                raise Refusal("ASSET_BYTES_CHANGED", entry_id,
                              f"the packer produced {parsed.get('size_bytes')} bytes / "
                              f"{parsed.get('sha256')}; the manifest records {size_bytes} / {row['sha256']}")
            proc = subprocess.run([sys.executable, str(PACKER), "--verify", str(out_path)],
                                  capture_output=True, text=True, timeout=600)
            if proc.returncode != 0:
                raise Refusal("ASSET_PACK_FAILED", entry_id,
                              "packer --verify refused: " + (proc.stderr.strip().splitlines() or ["?"])[-1])
            _facts_crosscheck(row, headline, json.loads(facts_path.read_text(encoding="utf-8")), env)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    # the needs block: the sibling catalogue's assembled facts (one assembly —
    # a pretrained card's verdicts never diverge from the method card's) plus
    # the curated asset facts.
    markers = method.get("markers") or {}
    marker_facts = {
        "kind": str(markers.get("kind") or "any"),
        "count": int(markers.get("count") or 0),
        "min_draws": int(method.get("min_draws") or 1),
        "needs_baseline": bool(method.get("needs_baseline") or False),
        "uses_history": str(method.get("uses_history") or "landmark"),
        "needs_detection_call": bool(method.get("needs_detection_call") or False),
        "marker_groups_required": [str(g) for g in (method.get("marker_groups_required") or [])],
    }
    if marker_facts["uses_history"] not in USES_HISTORY_VALUES:
        raise Refusal("NEEDS_INVALID", entry_id,
                      f"uses_history {marker_facts['uses_history']!r} is not one of {USES_HISTORY_VALUES}")
    needs = {
        "marker_facts": marker_facts,
        "required_markers": method.get("required_markers"),
        "covariates": str(method.get("covariates") or "none"),
        "decision_day": decision_day,
        "endpoint": row["endpoint"],
        "horizon": horizon,
        "task": row["task"] or None,
    }

    reg = ctx["registry"].get(row["method_id"], {})
    paper = {
        "journal": str(reg.get("journal") or "").strip(),
        "year": int(str(reg.get("year") or "").strip() or 0),
        "doi": str(reg.get("paper_doi") or "").strip(),
        "citation": row["citation"],
    }
    if not (paper["journal"] or paper["year"] or paper["doi"] or paper["citation"]):
        paper = None

    warnings = [{"code": code, "detail": sanitize_string(detail)}
                for code, detail in ctx["warnings"].get(row["method_id"], [])]

    return {
        "id": entry_id,
        "version": row["version"],
        "kind": row["kind"],
        "name": sanitize_string(row["name"]),
        "description": sanitize_string(row["description"]),
        "method_id": row["method_id"],
        "method_version": str(method.get("version") or ""),
        "group": str(method.get("group") or "other"),
        "group_label": GROUP_LABELS.get(str(method.get("group") or ""),
                                        str(method.get("group_label") or "")),
        "paper": paper,
        "needs": needs,
        "env": env,
        "contract": str((method.get("env") or {}).get("contract") or "2.0"),
        "embeds_training_data": bool(method.get("embeds_training_data") or False),
        "transfer": _transfer(row, ctx["scores"]),
        "assay_warnings": warnings,
        "research_notice": True,
        "licence": licence,
        "data_sources": sources,
        "asset": {
            "bundled": bundled,
            "file": row["file"],
            "url": url,
            "size_bytes": size_bytes,
            "sha256": row["sha256"],
            "signature": "",
        },
    }


# ---- contexts + gate ----
def _load_contexts(warnings_path, method_catalogue_path, env_images_path, sigtrans_root, manifest_rows):
    warnings = load_warnings(warnings_path)
    methods = load_method_catalogue(method_catalogue_path)
    envs = load_env_images(env_images_path)
    registry = load_registry_manifest(sigtrans_root / "dev" / "code" / "manifest" / "methods.csv")
    datasets = load_dataset_registry(sigtrans_root)
    ids = {row["method_id"] for row in manifest_rows}
    scores_by_metric = {metric: load_scores(sigtrans_root, ids, metric) for metric in TRANSFER_METRICS}
    return {"registry": registry, "methods": methods, "envs": envs, "datasets": datasets,
            "warnings": warnings, "scores_by_metric": scores_by_metric, "previous": {},
            "root": Path(sigtrans_root)}


def _previous(previous_path):
    if not previous_path or not Path(previous_path).exists():
        return {}
    doc = json.loads(Path(previous_path).read_text(encoding="utf-8"))
    return {(m["id"], m["version"]): m.get("asset") or {} for m in doc.get("models") or []}


def run_gate(manifest_path, warnings_path, method_catalogue_path, env_images_path,
             sigtrans_root, previous_path=None):
    """The entry gate (TEST-PC-12/16): validate every manifest row, collect the
    refusals. Never writes."""
    entries = load_manifest(manifest_path)
    loaded = _load_contexts(warnings_path, method_catalogue_path, env_images_path,
                            sigtrans_root, entries)
    loaded["previous"] = _previous(previous_path)
    refusals = []
    for row in sorted(entries, key=lambda r: (r["id"], r["version"])):
        loaded["scores"] = loaded["scores_by_metric"].get(row["transfer_metric"], {}) \
            if row["transfer_metric"] in loaded["scores_by_metric"] else {}
        try:
            build_entry(row, loaded)
        except Refusal as exc:
            refusals.append(exc)
    return refusals, loaded


def build_entries(manifest_rows, loaded):
    entries = []
    for row in sorted(manifest_rows, key=lambda r: (r["id"], r["version"])):
        loaded["scores"] = loaded["scores_by_metric"].get(row["transfer_metric"], {}) \
            if row["transfer_metric"] in loaded["scores_by_metric"] else {}
        entries.append(build_entry(row, loaded))
    return entries


def barcode_entries(entries):
    return [{"id": e["id"], "version": e["version"], "file": e["asset"]["file"],
             "url": e["asset"]["url"], "sha256": e["asset"]["sha256"],
             "size_bytes": e["asset"]["size_bytes"]}
            for e in entries if e["asset"]["bundled"]]


def assemble(entries, provenance):
    return {"schema_version": SCHEMA_VERSION, "generated_from": provenance, "models": entries}


def dump_to_text(doc):
    hits = hygiene_scan(doc)
    if hits:
        raise ValueError("catalogue hygiene failed:\n  " + "\n  ".join(hits[:20]))
    return json.dumps(doc, indent=1, sort_keys=True) + "\n"


def _normalise(doc):
    """--check probe: the data must match; generated_at is provenance, never a parity failure."""
    import copy
    d = copy.deepcopy(doc)
    d.get("generated_from", {}).pop("generated_at", None)
    return d


def _provenance(registry_root, is_fixture):
    if is_fixture:
        return {"registry_name": "fixtures (synthetic)", "registry_commit": "fixture",
                "models_repo": MODELS_REPO,
                "generated_at": _iso_time(int(os.environ.get("SOURCE_DATE_EPOCH") or FIXTURE_EPOCH))}
    return {"registry_name": "txresbench-benchmark", "registry_commit": git_head(registry_root),
            "models_repo": MODELS_REPO,
            "generated_at": _iso_time(int(os.environ.get("SOURCE_DATE_EPOCH")
                                           or datetime.datetime.now(datetime.timezone.utc).timestamp()))}


# ---- selftest (TEST-PC-12/16/26's matrix, driven by tests/pretrained_catalogue/gen_catalogue_test.rs) ----
def _expect_refusal(code, fn):
    try:
        fn()
    except Refusal as exc:
        if exc.code != code:
            raise AssertionError("expected %s, got %s (%s)" % (code, exc.code, exc))
        return
    raise AssertionError("expected the refusal %s" % code)


def selftest():
    checks = []

    def check(name, cond, detail=""):
        checks.append((name, bool(cond), detail))

    # the good fixture registry must pass the gate
    refusals, loaded = run_gate(FIXTURE_DIR / "manifest.tsv", FIXTURE_DIR / "assay-warnings.tsv",
                                FIXTURE_DIR / "method-catalogue.json", FIXTURE_DIR / "env-images.json",
                                FIXTURE_DIR)
    check("the good fixture manifest passes the gate",
          refusals == [], str([(r.code, r.id) for r in refusals]))

    manifest_rows = load_manifest(FIXTURE_DIR / "manifest.tsv")
    loaded["previous"] = {}
    entries = build_entries(manifest_rows, loaded)
    fx = {e["id"]: e for e in entries}

    check("entries are the three fixture models, in order",
          [e["id"] for e in entries] == ["fx-rule-001", "fx-rule-002", "fx-trained-001"],
          str([e["id"] for e in entries]))
    check("research_notice is true for every entry",
          all(e["research_notice"] is True for e in entries))
    check("bundled default is size-based; the curated override wins",
          fx["fx-rule-001"]["asset"]["bundled"] is True
          and fx["fx-rule-002"]["asset"]["bundled"] is True
          and fx["fx-trained-001"]["asset"]["bundled"] is False)
    check("asset urls are releases/download URLs, never browse URLs",
          all("/releases/download/" in e["asset"]["url"] and "/releases/tag/" not in e["asset"]["url"]
              and e["asset"]["url"].startswith(f"https://github.com/{MODELS_REPO}/releases/download/")
              for e in entries), str([e["asset"]["url"] for e in entries]))
    check("asset file names are <id>@<version>.txr; sha256 64-hex; signature empty",
          all(e["asset"]["file"] == f"{e['id']}@{e['version']}.txr" and SHA256_HEX.match(e["asset"]["sha256"])
              and e["asset"]["size_bytes"] > 0 and e["asset"]["signature"] == "" for e in entries))
    check("env digests come from the env-images manifest (INV-7)",
          fx["fx-rule-001"]["env"] == {"base_digest":
                                       "sha256:aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11",
                                       "layer_digest":
                                       "bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22"},
          str(fx["fx-rule-001"]["env"]))
    check("needs come from the sibling method catalogue + the curated asset facts",
          fx["fx-rule-002"]["needs"]["marker_facts"] == {
              "kind": "single", "count": 1, "min_draws": 2, "needs_baseline": True,
              "uses_history": "landmark", "needs_detection_call": False, "marker_groups_required": []}
          and fx["fx-rule-002"]["needs"]["covariates"] == "optional"
          and fx["fx-rule-002"]["needs"]["required_markers"]["markers"][0]["id"] == "fx-02"
          and fx["fx-rule-002"]["needs"]["decision_day"] == 56.0
          and fx["fx-rule-002"]["needs"]["endpoint"] == "os"
          and fx["fx-rule-002"]["needs"]["horizon"] == 238.0
          and fx["fx-rule-002"]["needs"]["task"] == "survival")
    check("a benchmark-trained entry skips the published-rule registry check",
          fx["fx-trained-001"]["kind"] == "benchmark-trained"
          and fx["fx-trained-001"]["embeds_training_data"] is True
          and fx["fx-trained-001"]["needs"]["covariates"] == "required")
    check("transfer aggregates from scores.csv (per-cohort medians + overall median)",
          fx["fx-rule-001"]["transfer"] == {"metric": "auc_rule", "median": 0.64, "n_cohorts": 2,
                                            "cohorts": [{"dataset": "fx-dataset-1", "value": 0.68},
                                                        {"dataset": "fx-dataset-2", "value": 0.6}]}
          and fx["fx-rule-002"]["transfer"] == {"metric": "c_index", "median": 0.62, "n_cohorts": 1,
                                                "cohorts": [{"dataset": "fx-dataset-2", "value": 0.62}]}
          and fx["fx-trained-001"]["transfer"] == {"metric": "c_index", "median": 0.575, "n_cohorts": 2,
                                                   "cohorts": [{"dataset": "fx-dataset-1", "value": 0.56},
                                                               {"dataset": "fx-dataset-2", "value": 0.59}]},
          str((fx["fx-rule-001"]["transfer"], fx["fx-rule-002"]["transfer"],
               fx["fx-trained-001"]["transfer"])))
    check("paper facts come from the benchmark registry",
          fx["fx-rule-001"]["paper"]["journal"] == "Synthetic Journal of Fixtures"
          and fx["fx-rule-001"]["paper"]["doi"] == "10.0000/fx.rule.001"
          and fx["fx-rule-001"]["paper"]["year"] == 2021)
    check("licence resolution + the curated override",
          fx["fx-rule-001"]["licence"] == "CC0 1.0"
          and fx["fx-rule-002"]["licence"] == "MIT (synthetic fixture)"
          and fx["fx-trained-001"]["licence"] == "CC0 1.0; MIT"
          and [s["access"] for s in fx["fx-rule-002"]["data_sources"]] == ["open", "open"])
    check("assay warnings are the method's curated rows",
          fx["fx-rule-001"]["assay_warnings"] ==
          [{"code": "LOD_CALLOUT", "detail": "The fixture assay's detection limit is synthetic (fixture warning)."}]
          and fx["fx-trained-001"]["assay_warnings"] == [])
    check("the packer re-run matches the manifest for every in-tree asset",
          True)  # a packer mismatch would have refused in build_entries above

    # the packer/facts cross-check refusals (tampered facts)
    tmp = Path(tempfile.mkdtemp(prefix="gen-pretrained-selftest-",
                                dir=os.environ.get("TMPDIR") or tempfile.gettempdir()))
    try:
        good_row = [r for r in manifest_rows if r["id"] == "fx-rule-001"][0]
        bad_facts = json.loads((FIXTURE_DIR / good_row["facts"]).read_text(encoding="utf-8"))
        bad_facts["licence"] = "tampered"
        bad_path = tmp / "facts.json"
        bad_path.write_text(json.dumps(bad_facts), encoding="utf-8")
        bad_row = dict(good_row, facts=str(bad_path))
        # the licence is a header field: a tampered facts file changes the
        # header and therefore the bytes — the byte refusal is the first line
        _expect_refusal("ASSET_BYTES_CHANGED",
                        lambda: build_entry(bad_row, dict(loaded, previous={}, scores={})))
        check("a tampered facts file refuses (its header breaks the byte contract)", True)

        bad_tree = tmp / "tree"
        bad_tree.mkdir()
        (bad_tree / "tampered.bin").write_bytes(b"tampered bytes")
        bad_row = dict(good_row, tree=str(bad_tree))
        _expect_refusal("ASSET_BYTES_CHANGED",
                        lambda: build_entry(bad_row, dict(loaded, previous={}, scores={})))
        check("a changed tree refuses ASSET_BYTES_CHANGED", True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    # TEST-PC-16: asset immutability — a changed sha256 under the same id+version
    def immutable_build(sha256_override):
        row = dict(good_row_for_immutable)
        row["sha256"] = sha256_override
        ctx = dict(loaded, previous={(good_row_for_immutable["id"], good_row_for_immutable["version"]):
                                     {"sha256": good_row_for_immutable["sha256"],
                                      "size_bytes": int(good_row_for_immutable["size_bytes"])}},
                   scores={})
        build_entry(row, ctx)

    good_row_for_immutable = [r for r in manifest_rows if r["id"] == "fx-rule-001"][0]
    _expect_refusal("ASSET_CHANGED_UNDER_VERSION",
                    lambda: immutable_build("0" * 63 + "1"))
    check("a changed sha256 under the same id+version refuses (TEST-PC-16)", True)

    # the TEST-PC-12 refusal matrix: each bad input refuses with its code
    for code, id_ in [
        ("ACCESS_CONTROLLED", "fx-controlled-001"),
        ("SOURCE_UNDECLARED", "fx-undeclared-001"),
        ("LICENCE_EMPTY", "fx-nolicence-001"),
        ("SOURCE_GENIE", "fx-genie-001"),
        ("ASSET_SHA256_FORMAT", "fx-nonhex-001"),
        ("PUBLISHED_RULE_NOT_FROZEN", "fx-notfrozen-001"),
        ("ENV_ENTRY_MISSING", "fx-envless-001"),
    ]:
        refusals, _ = run_gate(FIXTURE_DIR / "manifest-refusals.tsv",
                               FIXTURE_DIR / "assay-warnings.tsv",
                               FIXTURE_DIR / "method-catalogue.json", FIXTURE_DIR / "env-images.json",
                               FIXTURE_DIR)
        check(f"the gate refuses {code} naming the entry",
              any(r.code == code and r.id == id_ for r in refusals),
              str([(r.code, r.id) for r in refusals]))

    provenance = _provenance(FIXTURE_DIR, True)
    catalogue = assemble(entries, provenance)
    check("generated_from carries fixture provenance + the models repo",
          provenance["registry_commit"] == "fixture" and provenance["models_repo"] == MODELS_REPO
          and re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$", provenance["generated_at"]))
    check("no hosts outside the policy, no stud/status tokens in the document",
          hygiene_scan(catalogue) == [], " ".join(hygiene_scan(catalogue))[:300])
    bundled = barcode_entries(entries)
    check("bundled-models.json equals the asset fields of the bundled entries",
          [b["id"] for b in bundled] == ["fx-rule-001", "fx-rule-002"]
          and bundled == [{"id": "fx-rule-001", "version": "1.0.0",
                           "file": "fx-rule-001@1.0.0.txr",
                           "url": f"https://github.com/{MODELS_REPO}/releases/download/"
                                  "fx-rule-001-v1.0.0/fx-rule-001@1.0.0.txr",
                           "sha256": "ec32260606c50f2076bc959c6197d69b3414fb1b7ef9f5baeedd60625eada8fd",
                           "size_bytes": 1428},
                          {"id": "fx-rule-002", "version": "1.1.0",
                           "file": "fx-rule-002@1.1.0.txr",
                           "url": f"https://github.com/{MODELS_REPO}/releases/download/"
                                  "fx-rule-002-v1.1.0/fx-rule-002@1.1.0.txr",
                           "sha256": "d88ad92294d0d1960181af387ab211f434edf0223e600477cc8fedc14f26877d",
                           "size_bytes": 1438}], str(bundled))
    check("a fresh fixture generation writes byte-identical catalog + bundled + site copies",
          _fixture_byte_parity(entries))

    # the subprocess legs: --check-restricted exit codes
    good = subprocess.run([sys.executable, str(Path(__file__).resolve()),
                           "--fixtures", "--check-restricted"], capture_output=True, text=True)
    check("--check-restricted on the good manifest exits 0", good.returncode == 0, good.stdout[-200:])
    bad = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--fixtures",
                          "--manifest", str(FIXTURE_DIR / "manifest-refusals.tsv"),
                          "--check-restricted"], capture_output=True, text=True)
    check("--check-restricted on the refusal manifest exits 1 naming the entries",
          bad.returncode == 1 and "fx-controlled-001" in bad.stdout
          and "ACCESS_CONTROLLED" in bad.stdout and "fx-envless-001" in bad.stdout,
          bad.stdout[-400:])

    ok = all(c[1] for c in checks)
    for name, passed, detail in checks:
        print(("PASS" if passed else "FAIL") + f"  {name}" + (f"  [{detail}]" if detail and not passed else ""))
    print(("self-test OK" if ok else "self-test FAILED") + f"  ({len(checks)} checks)")
    return 0 if ok else 1


def _fixture_byte_parity(entries):
    """Write the three PROV-PC-1 files to a scratch dir and byte-compare:
    the snapshot and the served copy byte-identical; the bundled extract equal
    to the asset fields of the bundled entries; catalogue text stable."""
    tmp = Path(tempfile.mkdtemp(prefix="gen-pretrained-parity-",
                                dir=os.environ.get("TMPDIR") or tempfile.gettempdir()))
    try:
        provenance = _provenance(FIXTURE_DIR, True)
        catalogue = assemble(entries, provenance)
        catalog_text = dump_to_text(catalogue)
        bundled_text = dump_to_text({"schema_version": SCHEMA_VERSION, "models": barcode_entries(entries)})
        (tmp / "catalogue.json").write_text(catalog_text, encoding="utf-8")
        (tmp / "bundled-models.json").write_text(bundled_text, encoding="utf-8")
        (tmp / "site-catalogue.json").write_text(catalog_text, encoding="utf-8")
        snapshot = json.loads((tmp / "catalogue.json").read_text(encoding="utf-8"))
        site = json.loads((tmp / "site-catalogue.json").read_text(encoding="utf-8"))
        bundled_doc = json.loads((tmp / "bundled-models.json").read_text(encoding="utf-8"))
        if (tmp / "catalogue.json").read_text(encoding="utf-8") != (tmp / "site-catalogue.json").read_text(encoding="utf-8"):
            return False
        asset_slots = [m for m in snapshot["models"] if m["asset"]["bundled"]]
        expected = [{"id": m["id"], "version": m["version"], "file": m["asset"]["file"],
                     "url": m["asset"]["url"], "sha256": m["asset"]["sha256"],
                     "size_bytes": m["asset"]["size_bytes"]} for m in asset_slots]
        return bundled_doc["models"] == expected and site == snapshot
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Generate the TxResBench pretrained-model catalogue "
                    "(data/pretrained-catalogue/catalogue.json + bundled-models.json + site copy)")
    ap.add_argument("--out", default=None)
    ap.add_argument("--bundled-out", default=None)
    ap.add_argument("--site-out", default=None)
    ap.add_argument("--manifest", default=None)
    ap.add_argument("--warnings", default=None)
    ap.add_argument("--method-catalogue", default=None)
    ap.add_argument("--env-images", default=None)
    ap.add_argument("--fixtures", action="store_true", help="use the synthetic fixture registry")
    ap.add_argument("--check", action="store_true", help="regenerate and compare with the targets")
    ap.add_argument("--check-restricted", action="store_true",
                    help="run the entry gate only (writes nothing)")
    ap.add_argument("--selftest", action="store_true", help="run the generator invariants")
    ap.add_argument("--root", default=os.environ.get("SIGTRANS_ROOT", str(DEFAULT_SIGTRANS_ROOT)),
                    help="benchmark tree root (default SIGTRANS_ROOT or /data/share/pbya/sigtrans)")
    a = ap.parse_args(argv)

    if a.selftest:
        return selftest()

    if a.fixtures:
        manifest = Path(a.manifest) if a.manifest else FIXTURE_DIR / "manifest.tsv"
        root = FIXTURE_DIR
        method_catalogue = FIXTURE_DIR / "method-catalogue.json"
        env_images = FIXTURE_DIR / "env-images.json"
        warnings = FIXTURE_DIR / "assay-warnings.tsv"
        out = Path(a.out) if a.out else FIXTURE_EXPECTATION
        bundled_out = Path(a.bundled_out) if a.bundled_out else FIXTURE_EXPECTATION_BUNDLED
        site_out = Path(a.site_out) if a.site_out else FIXTURE_SITE_OUT
    else:
        manifest = Path(a.manifest) if a.manifest else DEFAULT_MANIFEST
        root = Path(a.root)
        method_catalogue = Path(a.method_catalogue) if a.method_catalogue else DEFAULT_METHOD_CATALOGUE
        env_images = Path(a.env_images) if a.env_images else DEFAULT_ENV_IMAGES
        warnings = Path(a.warnings) if a.warnings else DEFAULT_WARNINGS
        out = Path(a.out) if a.out else DEFAULT_CATALOGUE
        bundled_out = Path(a.bundled_out) if a.bundled_out else DEFAULT_BUNDLED
        site_out = Path(a.site_out) if a.site_out else DEFAULT_SITE_FILE

    if a.check_restricted:
        previous = FIXTURE_EXPECTATION if a.fixtures else DEFAULT_CATALOGUE
        refusals, _ = run_gate(manifest, warnings, method_catalogue, env_images, root,
                               previous_path=previous)
        for r in refusals:
            print("ERROR %s: %s: %s" % (r.code, r.id, r.detail))
        if refusals:
            print("gate: %d entry(ies) refused" % len(refusals))
            return 1
        print("gate: OK (%d entries)" % len(load_manifest(manifest)))
        return 0

    provenance = _provenance(root, a.fixtures)
    manifest_rows = load_manifest(manifest)
    loaded = _load_contexts(warnings, method_catalogue, env_images, root, manifest_rows)
    loaded["previous"] = _previous(FIXTURE_EXPECTATION if a.fixtures else DEFAULT_CATALOGUE)
    entries = build_entries(manifest_rows, loaded)
    catalogue = assemble(entries, provenance)
    text = dump_to_text(catalogue)
    bundled_text = dump_to_text({"schema_version": SCHEMA_VERSION, "models": barcode_entries(entries)})

    if a.check:
        if a.fixtures:
            for target, fresh in ((out, text), (bundled_out, bundled_text)):
                if not target.exists():
                    print(f"check: {target} does not exist")
                    return 1
                if target.read_text(encoding="utf-8") != fresh:
                    print(f"check: {target} is stale (fresh fixture generation differs)")
                    return 1
            print(f"check: catalogue + bundled manifest match a fresh fixture generation "
                  f"({len(catalogue['models'])} models)")
            return 0
        for target, fresh_doc in ((out, catalogue),
                                  (bundled_out, {"schema_version": SCHEMA_VERSION,
                                                 "models": barcode_entries(entries)})):
            if not target.exists():
                print(f"check: {target} does not exist")
                return 1
            if _normalise(json.loads(target.read_text(encoding="utf-8"))) != _normalise(fresh_doc):
                print(f"check: {target} is stale (fresh generation differs)")
                return 1
        # the served copy's contract (PROV-landing-site-2): byte-identical to
        # the embedded snapshot — both from ONE generation run, so the bytes
        # are compared file-to-file (generated_at is the same run's date)
        if site_out.exists() and site_out.read_text(encoding="utf-8") != out.read_text(encoding="utf-8"):
            print(f"check: {site_out} is not byte-identical to the embedded snapshot")
            return 1
        print(f"check: catalogue + bundled manifest match a fresh generation "
              f"({len(catalogue['models'])} models)")
        return 0

    out.parent.mkdir(parents=True, exist_ok=True)
    bundled_out.parent.mkdir(parents=True, exist_ok=True)
    site_out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")
    bundled_out.write_text(bundled_text, encoding="utf-8")
    site_out.write_text(text, encoding="utf-8")
    print(f"wrote {out}: {len(catalogue['models'])} models, "
          f"{sum(1 for e in entries if e['asset']['bundled'])} bundled")
    print(f"wrote {bundled_out}: {len(catalogue['models'] and barcode_entries(entries))} bundled assets")
    print(f"wrote {site_out}: byte-identical copy")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Refusal as exc:
        sys.stderr.write("ERROR %s: %s: %s\n" % (exc.code, exc.id, exc.detail))
        sys.stderr.write("no catalogue file was written\n")
        sys.exit(1)
