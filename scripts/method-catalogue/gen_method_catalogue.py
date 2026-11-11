#!/usr/bin/env python3
"""Build the TxResBench app's method catalogue (method-catalogue node, generator part).

Reads the BENCHMARK tree at BUILD time only (INV-1: the app ships its own copy, generated
by a script, never read at run time) and writes the single committed catalogue file
`data/method-catalogue/catalogue.json` (PROV-MC-1, schema version 1). Inputs follow DECISIONS.md
DEC-1: the per-method package manifests (`methods/methods/<id>/method.json`), the gate results
(`methods/gates/<id>.json`), the registry facts (`dev/code/manifest/methods.csv`), the curated
draw facts (`dev/code/benchmark/schema/per-method/mindraws/*.json`), the curated marker
vocabulary (`dev/analysis-catalog/datasets/*/{markers,mapping}.yaml`), and the benchmark's own
stored aggregate results (`results/benchmark/{runs,scores}.csv`). The candidate spec YAMLs stay
out (DEC-1). The runnable set only is emitted (DEC-2).

Usage:
    python3 scripts/method-catalogue/gen_method_catalogue.py [--out data/method-catalogue/catalogue.json]
        --fixtures        read the synthetic fixture registry (scripts/method-catalogue/fixtures/)
                          instead of SIGTRANS_ROOT; deterministic commits + generated_at
        --check           regenerate and byte-compare with the target file; exit 1 on a mismatch
                          (real mode: data/method-catalogue/catalogue.json; fixture mode:
                          scripts/method-catalogue/fixtures/expected-catalogue.json)
        --selftest        run the generator's own invariant checks against the fixture registry
                          (TEST-MC-15/TEST-MC-16) and exit 0/1
        --propose-groups  write `marker-groups.proposed.tsv` with the auto-derived
                          (system,id) -> group/unit rows for the current registry (curation aid;
                          the committed marker-groups.tsv stays hand-confirmed, OWNER-3)
        SIGTRANS_ROOT     environment override for the benchmark tree (default /data/share/pbya/sigtrans)
        SOURCE_DATE_EPOCH timestamp override for generated_at (reproducible builds)

Reproducibility: no network, no machine paths, output deterministic under SOURCE_DATE_EPOCH
(DEC-14). Hygiene (INV-5/TEST-MC-18): every emitted string is passed through the sanitizers
(URLs removed, case-insensitive `stud(y|ies)` tokens replaced) and the final document is
re-scanned — any residual http(s):// literal, `stud(y|ies)` token or status/progress/placeholder
token aborts the run with a named error, never silently shipped.
"""
import argparse
import collections
import csv
import datetime
import json
import os
import re
import statistics
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
DEFAULT_CATALOGUE = REPO_ROOT / "data" / "method-catalogue" / "catalogue.json"
DEFAULT_FIXTURE_EXPECTATION = SCRIPT_DIR / "fixtures" / "expected-catalogue.json"
DEFAULT_SIGTRANS_ROOT = Path("/data/share/pbya/sigtrans")
FIXTURE_EPOCH = 1767225600  # 2026-01-01T00:00:00Z — deterministic fixture provenance

CONTRACT = "2.0"
REGISTRY_PREFIX = "ghcr.io/tinnlab"

SCHEMA_VERSION = 1
# the qa-fixes3 ITEM-1 human-name fields (the plan's limits; the server types pin
# the same constants as contract)
MAX_TITLE_CHARS = 60
MAX_SUMMARY_CHARS = 170
GROUP_LABELS = {
    "response-call": "Response call",
    "response-probability": "Response probability",
    "static-risk": "Static risk",
    "dynamic-risk": "Dynamic risk",
}
BOARD_GROUPS = [
    ("ctdna", "Tumour DNA in blood (ctDNA)"),
    ("counts", "Blood counts (white cells, platelets, haemoglobin)"),
    ("ldh", "LDH"),
    ("tumour-markers", "Tumour markers (CEA, CA 19-9, CA-125, PSA)"),
    ("inflammation", "Inflammation or cytokines (CRP, IL-6)"),
    ("methylation-sequencing", "Methylation or other sequencing"),
    ("other", "Other markers"),
]
BOARD_GROUP_IDS = [g[0] for g in BOARD_GROUPS]
# fallback estimate constants (DEC-7): used for timing.base_seconds_per_fold when a method has no
# benchmarked unit (timing.quality: "estimate")
FALLBACK_SECONDS = {"R": 60.0, "Python": 120.0}

# ---- data.py rule ports (DEC-5): every regex here is a faithful copy of                    ----
# dev/code/benchmark/runner/data.py (lines 131-160) so standard-id parsing stays in sync
_LOINC_KEY = re.compile(r"(?i)\bLOINC\b")
_LOINC_CODE = re.compile(r"\b\d{2,6}-\d{1,2}\b")
_HGNC = re.compile(r"(?i)\bHGNC\b\s*:?\s*([A-Za-z0-9][A-Za-z0-9_.\-]*)")
_GENE = re.compile(r"(?i)\bgene\b\s*:?\s*([A-Z][A-Z0-9][A-Z0-9_.\-]*)")
_UNIPROT = re.compile(r"(?i)\bUniProt\b\s*\(?\s*([OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9][A-Z][A-Z0-9]{2}[0-9][A-Z0-9]{2}[0-9])")
_UNIPROT_ACC = re.compile(r"\b[OPQ][0-9][A-Z0-9]{3}[0-9]\b|\b[A-NR-Z][0-9][A-Z][A-Z0-9]{2}[0-9][A-Z0-9]{2}[0-9]\b")
_HMDB = re.compile(r"(?i)\bHMDB\d{6,8}\b")
_MIRBASE = re.compile(r"(?i)\b(MIMAT\d{5,}|MI\d{7})\b")
_HGNC_STOP = {"term", "id", "identifier", "symbol", "name", "gene", "genes"}


def parse_standard_ids(text):
    """(system, id) pairs in a `standard_id` free-text; the id set equals data.py's parse_standard_ids."""
    if not text:
        return []
    t = str(text)
    out = []
    for clause in re.split(r"[;()\[\]{}]", t):
        if _LOINC_KEY.search(clause):
            for c in _LOINC_CODE.findall(clause):
                out.append(("LOINC", c))
    hg = re.sub(r"(?i)\bno\s+HGNC\b", " no-hgnc ", t)
    for x in _HGNC.findall(hg):
        if x.lower() not in _HGNC_STOP:
            out.append(("HGNC", x))
    for x in _GENE.findall(t):
        out.append(("HGNC", x))
    for x in _UNIPROT.findall(t):
        out.append(("UNIPROT", x))
    if re.search(r"(?i)uniprot", t):
        for x in _UNIPROT_ACC.findall(t):
            out.append(("UNIPROT", x))
    for x in _HMDB.findall(t):
        out.append(("HMDB", x))
    for x in _MIRBASE.findall(t):
        out.append(("MIRBASE", x))
    return out


# ---- sanitizers (INV-5 / TEST-MC-18) ----
_URL_RE = re.compile(r"https?://\S+", re.I)
_STUD_RE = re.compile(r"\bstud(?:ies|y)\b", re.I)
_STATUS_RE = re.compile(r"\bplaceholder\b|\bin\s+progress\b|\b(?:todo|fixme|wip)\b", re.I)


def _status_sub(m):
    word = m.group(0).lower()
    if word == "placeholder":
        return "blank"  # e.g. "a placeholder string" -> "a blank string" (the fact survives)
    if word == "in progress":
        return "under way"
    return ""  # todo/fixme/wip are removed outright


def sanitize_string(s):
    # URLs are removed whole (no scheme literal may ship); `stud(y|ies)` becomes "research";
    # status/placeholder tokens are neutralized (INV-5: published files carry no status text).
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


def sanitize_value(v):
    if isinstance(v, str):
        return sanitize_string(v)
    if isinstance(v, list):
        return [sanitize_value(x) for x in v]
    if isinstance(v, dict):
        return {k: sanitize_value(x) for k, x in v.items()}
    return v


# ---- human-name fields (qa-fixes3 ITEM-1) ----
# The catalogue carries a short human `title`, a one-sentence `summary` and,
# when the benchmark tree knows it, the primary paper's `paper_title` — the
# row/About facts the redesigned method list shows. All three are derived at
# BUILD time from the method's own `description` (the lead phrase / first
# sentence) plus the literature store, so no app code ever reads the tree.
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+(?=[A-Z(])")
_ABBREVIATION_TAILS = {
    "al", "e.g", "i.e", "etc", "fig", "no", "dr", "vs", "esq", "inc", "ltd",
    "mr", "mrs", "ms", "st", "vol",
}


def cut_phrase(text, limit):
    """`text` cut at a word boundary to <= `limit` chars, trailing punctuation
    stripped (the title/summary caps; never a mid-word cut, never empty for a
    non-empty input)."""
    t = re.sub(r"\s+", " ", (text or "")).strip()
    if len(t) <= limit:
        return t.rstrip(" ,;:.-()")
    head = t[: limit + 1]
    sp = head.rfind(" ", 0, limit + 1)
    if sp > 0:
        head = head[:sp]
    return head.rstrip(" ,;:.-()")


def first_sentence(text):
    """The description's first sentence. The split rewinds after a known
    abbreviation tail (`et al. (Gut 2017, ...` never splits at `al.`), so a
    citation inside the sentence does not truncate it."""
    parts = _SENTENCE_END.split((text or "").strip())
    sentence = parts[0]
    i = 1
    while i < len(parts):
        tail = sentence.strip().split()[-1].rstrip(".").lower() if sentence.strip() else ""
        if tail in _ABBREVIATION_TAILS:
            sentence = (sentence + " " + parts[i]).strip()
            i += 1
        else:
            break
    return sentence


def prettify_id(mid):
    """The id-prettified fallback (`cox-timevarying-slope` -> `Cox
    Timevarying Slope`): the one stable, readable form when the description
    yields no lead phrase."""
    return " ".join(w.capitalize() for w in re.split(r"[-_]+", str(mid)) if w)


def derive_title(mid, description):
    """The plan's short human name: the description's lead phrase (its first
    sentence, <= MAX_TITLE_CHARS at a word boundary), falling back to the
    prettified id — never empty."""
    d = sanitize_string(description or "")
    t = cut_phrase(first_sentence(d), MAX_TITLE_CHARS) if d else ""
    if not t:
        t = cut_phrase(d, MAX_TITLE_CHARS) if d else ""
    return t or prettify_id(mid)


def derive_summary(description):
    """The plan's one-sentence summary: the description's first sentence,
    capped at MAX_SUMMARY_CHARS at a word boundary. `first_sentence` may be
    empty for a degenerate description; the cap falls back to the lead phrase."""
    d = sanitize_string(description or "")
    s = cut_phrase(first_sentence(d), MAX_SUMMARY_CHARS) if d else ""
    if not s and d:
        s = cut_phrase(d, MAX_SUMMARY_CHARS)
    return s


_DOI_NORMALIZE = re.compile(r"^(?:doi:|https?://(?:dx\.)?doi\.org/)")


def normalize_doi(raw):
    """The DOI's canonical lookup form (lowercase, scheme/prefix stripped) —
    the literature store's `**DOI:**` lines and the methods' `references`
    spell the same DOI differently."""
    d = _DOI_NORMALIZE.sub("", str(raw or "").lower().strip())
    return re.sub(r"[\s]+", "", d)


def load_paper_titles(literature_md_dir):
    """DOI -> published title from the literature store's raw markdown
    (build-time only; the dir need not exist — `paper_title` is then `None`
    everywhere). The store is live-edited paper text, so the map is a
    snapshot the committed catalogue pins (regen parity covers drift)."""
    titles = {}
    if not literature_md_dir.is_dir():
        return titles
    for f in sorted(literature_md_dir.glob("*.md")):
        try:
            title = None
            doi = None
            with open(f, encoding="utf-8", errors="replace") as fh:
                for i, line in enumerate(fh):
                    if i > 40:
                        break
                    if line.startswith("# ") and title is None:
                        title = line[2:].strip()
                    m = re.search(r"\*\*DOI:\*\*\s*(\S+)", line)
                    if m and doi is None:
                        doi = m.group(1)
                    if title and doi:
                        break
            if title and doi:
                titles.setdefault(normalize_doi(doi), title)
        except (OSError, UnicodeError):
            continue
    return titles


def derive_paper_title(manifest_doi, references, titles):
    """The primary paper's title when the benchmark tree knows it: the
    manifest's `paper_doi` first, then each reference, first hit wins; `None`
    when nothing resolves (the plan's "when known")."""
    for doi in [manifest_doi] + list(references or []):
        t = titles.get(normalize_doi(doi))
        if t:
            return sanitize_string(t)
    return None


def hygiene_scan(value, where="."):
    """Hygiene violations (urls, stud tokens, status/placeholder tokens) in a value tree."""
    hits = []
    if isinstance(value, str):
        for m in _URL_RE.finditer(value):
            hits.append(f"{where}: http(s):// literal")
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


# ---- curated marker mapping (marker-groups.tsv) ----
def load_tsv_rows(path):
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) < 5:
                raise ValueError(f"{path}: malformed row {line!r}")
            rows.append({"system": parts[0].strip().lower(), "id": parts[1].strip().lower(),
                         "group": parts[2].strip(), "unit_family": parts[3].strip(),
                         "canonical_unit": parts[4].strip()})
    return rows


def load_warnings(path):
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) < 2:
                raise ValueError(f"{path}: malformed row {line!r}")
            rows.append({"method_id": parts[0].strip(),
                         "embeds_training_data": parts[1].strip().lower() in ("true", "1", "yes")})
    return rows


# ---- marker unit-family heuristics (curated tsv wins; OWNER-3 review) ----
_UNIT_RULES = [
    ("percent", r"%|percent|proportion|percentage"),
    ("ratio", r"\bration?\b|\bnlr\b"),
    ("concentration_mass", r"ng/ml|µg/ml|ug/ml|mg/ml|mg/l|g/l|ng/l|pg/ml|pg/l|ng/mg|mass/volume|\[mass/"),
    ("concentration_molar", r"mol/l|mmol/l|umol/l|nmol/l|pmol/l|moles/volume|\[moles/"),
    ("count", r"count|cell|\b#\b|#/volume|\[#/|per ml|per ?µl|x10|10\^9|10\^6|k/µl|/mm3"),
    ("detection", r"\bstatus\b|detectab|detection call|binary (?:status|call)"),
]
_UNIT_TOKEN = re.compile(
    r"(?i)\b(\d+(?:\.\d+)?\s*(?:ng|µg|ug|mg|pg|g|mmol|umol|nmol|pmol|mol|u|IU|kU|U)\s*/\s*(?:mL|L|uL|µL|dL)"
    r"|cells/mm3|10\^9/L|x10\^9/L|\d+(?:\.\d+)?\s*U/L|\d+(?:\.\d+)?\s*IU/mL|%)\b")


def derive_unit(text):
    t = (text or "").lower()
    for family, pattern in _UNIT_RULES:
        if re.search(pattern, t):
            m = _UNIT_TOKEN.search(text or "")
            return family, (m.group(1).strip() if m else "")
    return "none", ""


# ---- registry layout ----
class Registry:
    """Paths of one registry (the real benchmark tree or the synthetic fixtures)."""

    def __init__(self, root, is_fixture):
        self.root = Path(root)
        self.is_fixture = is_fixture
        if is_fixture:
            self.methods_dir = self.root / "methods"
            self.gates_dir = self.root / "gates"
            self.manifest = self.root / "registry" / "methods.csv"
            self.mindraws_dir = self.root / "mindraws"
            self.catalog_dir = self.root / "catalog" / "datasets"
            self.runs_csv = self.root / "results" / "runs.csv"
            self.scores_csv = self.root / "results" / "scores.csv"
        else:
            self.methods_dir = self.root / "methods" / "methods"
            self.gates_dir = self.root / "methods" / "gates"
            self.manifest = self.root / "dev" / "code" / "manifest" / "methods.csv"
            self.mindraws_dir = self.root / "dev" / "code" / "benchmark" / "schema" / "per-method" / "mindraws"
            self.catalog_dir = self.root / "dev" / "analysis-catalog" / "datasets"
            self.runs_csv = self.root / "results" / "benchmark" / "runs.csv"
            self.scores_csv = self.root / "results" / "benchmark" / "scores.csv"
        # the paper-title source (qa-fixes3 ITEM-1): the literature store's raw
        # markdown carries the `# title` + `**DOI:**` per paper; the fixture
        # registry ships no store, so `paper_title` is null under `--fixtures`.
        self.literature_md_dir = (self.root / "literature-store" / "papers" / "_raw" / "md"
                                  if not is_fixture else None)

    def check(self):
        missing = [str(p) for p in (self.methods_dir, self.gates_dir, self.manifest,
                                    self.mindraws_dir, self.catalog_dir, self.runs_csv, self.scores_csv)
                   if not p.exists()]
        if missing:
            raise FileNotFoundError("registry is missing: " + ", ".join(missing))


def git_head(repo):
    try:
        return subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True,
                              text=True, check=True, timeout=30).stdout.strip()
    except Exception:
        return ""


def load_manifest(path):
    with open(path, newline="", encoding="utf-8") as f:
        return {r["method"]: r for r in csv.DictReader(f) if r.get("method")}


def load_gates(gates_dir):
    gates = {}
    for f in sorted(gates_dir.glob("*.json")):
        try:
            gates[f.stem] = json.loads(f.read_text(encoding="utf-8"))
        except Exception as e:
            raise ValueError(f"{f}: gate not valid JSON ({e})")
    return gates


def load_mindraws(mindraws_dir):
    records = {}
    for f in sorted(mindraws_dir.glob("*.json")):
        try:
            docs = json.loads(f.read_text(encoding="utf-8"))
        except Exception as e:
            raise ValueError(f"{f}: mindraws not valid JSON ({e})")
        if not isinstance(docs, list):
            raise ValueError(f"{f}: expected a JSON list of records")
        for rec in docs:
            m = rec.get("method")
            if m and m not in records:
                records[m] = rec
    return records


def _aslist(x):
    if x is None:
        return []
    if isinstance(x, list):
        return x
    return [x]


def _yaml_load(path):
    try:
        import yaml  # local import: the generator needs PyYAML, the app runtime does not
    except ImportError:
        raise RuntimeError("PyYAML is required to read the curated marker vocabulary (pip install pyyaml)")
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def load_catalog_markers(catalog_dir):
    """Curated marker facts of every dataset: markers.yaml names + mapping.yaml rows."""
    names = {}  # marker id (lower) -> [(name, dataset)]
    for mf in sorted(catalog_dir.glob("*/markers.yaml")):
        try:
            docs = _yaml_load(mf)
        except Exception as e:
            raise ValueError(f"{mf}: markers.yaml not valid YAML ({e})")
        for m in (docs or {}).get("markers") or []:
            mid = m.get("id")
            if mid:
                names.setdefault(str(mid).lower(), []).append((str(m.get("name") or ""), mf.parent.name))
    rows = []  # mapping.yaml rows: status mapped/partly only
    for mf in sorted(catalog_dir.glob("*/mapping.yaml")):
        try:
            docs = _yaml_load(mf)
        except Exception as e:
            raise ValueError(f"{mf}: mapping.yaml not valid YAML ({e})")
        for r in (docs or {}).get("mapping") or []:
            if str(r.get("status") or "").split(" ")[0] not in ("mapped", "partly"):
                continue
            rows.append({"marker": str(r.get("marker") or ""), "standard_id": str(r.get("standard_id") or ""),
                         "dataset_features": [str(f) for f in _aslist(r.get("dataset_features"))],
                         "dataset": mf.parent.name})
    return names, rows


def load_timings(runs_csv):
    """per-method {seconds: [...], units: set} over status==ok rows (CONS-MC-2)."""
    timing = collections.defaultdict(lambda: {"seconds": [], "units": set()})
    with open(runs_csv, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if r.get("status") != "ok":
                continue
            try:
                t = float(r.get("seconds"))
            except (TypeError, ValueError):
                continue
            timing[r["method"]]["seconds"].append(t)
            timing[r["method"]]["units"].add(r.get("unit") or "")
    return timing


def load_performance(scores_csv, method_ids):
    """per-method {metric: {unit: {values: set, dataset: str}}} over primary units (CONS-MC-2)."""
    perf = collections.defaultdict(lambda: collections.defaultdict(dict))
    with open(scores_csv, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if r.get("metric") not in ("c_index", "auc_rule"):
                continue
            if r.get("primary") != "True":
                continue
            m = r.get("method")
            if m not in method_ids:
                continue
            try:
                v = float(r.get("value"))
            except (TypeError, ValueError):
                continue
            u = r.get("unit") or ""
            slot = perf[m][r["metric"]].setdefault(u, {"values": set(), "dataset": ""})
            slot["values"].add(v)
            if not slot["dataset"]:
                slot["dataset"] = r.get("dataset") or ""
    return perf


def read_method_json(registry, method_id):
    p = registry.methods_dir / method_id / "method.json"
    if not p.exists():
        return None
    return json.loads(p.read_text(encoding="utf-8"))


def _needs_detection_call(rm_markers):
    """The needs_detection_call rule: a required marker whose NAME names
    detection/detectability is a call marker (the method consumes the call
    status, not a measured level — marker-type detection, not a value)."""
    return any(re.search(r"detection|detectability", str(m.get("name") or ""), re.I)
               for m in rm_markers)


def _marker_kind(markers_n, required):
    """markers.kind mapping: 'single' | 'panel' (fixed named list) | 'multi' | 'any'."""
    if isinstance(markers_n, int):
        if markers_n <= 1:
            return "single", 1
        if (required or {}).get("markers"):
            return "panel", markers_n
        return "multi", markers_n
    s = str(markers_n).strip().lower()
    if s in ("any", "*"):
        return "any", 0
    return "single", 1


def _task_list(tasks):
    if not tasks:
        return []
    return [t for t in re.split(r"[\s,;]+", str(tasks).strip()) if t]


def _timing_for(mid, timings, language):
    t = timings.get(mid, {"seconds": [], "units": set()})
    units = {u for u in t["units"] if u}
    if t["seconds"]:
        return {"base_seconds_per_fold": float(statistics.median(t["seconds"])),
                "benchmarked_units": len(units), "quality": "measured"}
    return {"base_seconds_per_fold": float(FALLBACK_SECONDS.get(language, FALLBACK_SECONDS["Python"])),
            "benchmarked_units": 0, "quality": "estimate"}


def _performance_for(mid, perf):
    slots = perf.get(mid)
    if not slots:
        return None

    def med(metric):
        slot = slots.get(metric, {})
        if not slot:
            return None
        return float(statistics.median([statistics.mean(sorted(s["values"])) for s in slot.values()]))

    units = {u for metric in slots.values() for u in metric}
    datasets = {s["dataset"] for metric in slots.values() for s in metric.values()}
    return {"c_index_median": med("c_index"), "auc_rule_median": med("auc_rule"),
            "n_units": len(units), "n_datasets": len(datasets)}


_VOCAB_ALIASES = {}  # (system, id.lower()) -> display alias; filled before method entries


def build_vocabulary(used_required, required_case, names, map_rows, group_map):
    """The union vocabulary: method-required (system, id) + curated dataset markers."""
    vocab = collections.OrderedDict()

    def slot(system, idd, name="", curated=False):
        key = (str(system).lower(), str(idd).lower())
        if key not in vocab:
            row = group_map.get(key)
            vocab[key] = {"id": str(idd), "system": str(system).upper(), "display_name": "",
                          "aliases": [], "groups": [row["group"] if row else "other"],
                          "unit_family": row["unit_family"] if row else "none",
                          "canonical_unit": row["canonical_unit"] if row else "",
                          "names": collections.Counter(), "curated": set()}
        if name:
            vocab[key]["names"][name] += 1
            if curated:
                vocab[key]["curated"].add(name)
        return key

    for key in sorted(used_required):
        slot(key[0], required_case.get(key, key[1]))
    for r in map_rows:
        parsed = parse_standard_ids(r["standard_id"]) if r["standard_id"] else []
        key = None
        if parsed:
            for system, idd in parsed:
                if r["marker"]:
                    key = slot(system, idd, name=r["marker"])
        elif r["marker"]:
            key = slot("other", r["marker"], name=r["marker"])
        # dataset feature spellings stay aliases of the marker's key (join offer), never own entries
        for f in r["dataset_features"]:
            if f:
                if key is None:
                    key = slot("other", f, name=f)
                else:
                    vocab[key]["names"][f] += 1
    # the curated markers.yaml names attach to the vocab key of the same mapping row (display names)
    for r in map_rows:
        key = _find_vocab_key(vocab, r)
        for name, _dataset in names.get(r["marker"].lower(), []):
            if key and name:
                vocab[key]["names"][name] += 1
                vocab[key]["curated"].add(name)
    _VOCAB_ALIASES.clear()
    for key, v in vocab.items():
        curated = [n for n in v["curated"] if n]
        pool = curated or [n for n in v["names"] if n]
        if pool:
            # tie-break by name: sort stability must never depend on set hash order
            v["display_name"] = sorted(pool, key=lambda n: (-v["names"][n], len(n), n))[0]
        else:
            v["display_name"] = v["id"]
        v["aliases"] = [a for a in sorted({n for n in v["names"] if n and n != v["display_name"]})][:12]
        if v["unit_family"] == "none" and not v["canonical_unit"]:
            fam, unit = derive_unit(" ".join([v["display_name"]] + v["aliases"]))
            if fam != "none" or unit:
                v["unit_family"], v["canonical_unit"] = fam, unit
        v["n_methods"] = used_required.get(key, 0)
        _VOCAB_ALIASES[key] = {"id": v["id"], "display": v["display_name"], "aliases": v["aliases"]}
    out = []
    for key, v in sorted(vocab.items(), key=lambda kv: (kv[0][0], kv[0][1])):
        out.append({"id": v["id"], "system": v["system"], "display_name": sanitize_string(v["display_name"]),
                    "aliases": [sanitize_string(a) for a in v["aliases"]], "groups": v["groups"],
                    "unit_family": v["unit_family"] or "none",
                    "canonical_unit": v["canonical_unit"] or "", "n_methods": v["n_methods"]})
    return out


def _find_vocab_key(vocab, row):
    """The vocab key a mapping row contributed (structured ids first, then the OTHER marker key)."""
    parsed = parse_standard_ids(row["standard_id"]) if row["standard_id"] else []
    if parsed:
        for system, idd in parsed:
            key = (system.lower(), idd.lower())
            if key in vocab:
                return key
    key = ("other", row["marker"].lower())
    return key if key in vocab else None


def _marker_groups_required(mj, md, required_keyed, group_map):
    """marker_groups_required: the required markers' groups, else vocabulary-alias groups.

    An unmapped STRUCTURED id (e.g. an HGNC gene the curated tsv does not cover) adds no group —
    the specific marker is checked against the file, not the group panel; an unmapped OTHER-system
    id (an assay-defined quantity such as NLR or ctDNA_status) is genuinely an "other markers" item.
    """
    groups = []
    if required_keyed:
        for k in required_keyed:
            row = group_map.get(k)
            if row:
                groups.append(row["group"])
            elif k[0] == "other":
                groups.append("other")
    elif (str(mj.get("markers") or "any") != "any"
          and not str(md.get("marker_specificity") or "").strip().lower().startswith("any")):
        ctx = " ".join([str(md.get("marker_specificity") or ""), str(md.get("marker_origin") or "")])
        for (system, _mid), entry in sorted(_VOCAB_ALIASES.items()):
            probes = [entry["id"]] + [p for p in entry["aliases"] if p]
            hit = False
            for p in probes:
                if len(p) < 3:
                    continue
                # case-sensitive for bare words (so "eGFR" never matches the HGNC id EGFR);
                # OTHER ids and digit/space-bearing spellings match case-insensitively
                flags = re.I if (system == "other" or re.search(r"[\d\s]", p)) else 0
                if re.search(r"(?<![0-9a-zA-Z])" + re.escape(p) + r"(?![0-9a-zA-Z])", ctx, flags):
                    hit = True
                    break
            if hit:
                row = group_map.get((system, _mid))
                if row:
                    groups.append(row["group"])
                elif system == "other":
                    groups.append("other")
    return sorted({g for g in groups})


def _provenance(registry):
    if registry.is_fixture:
        return {"registry_name": "fixtures (synthetic)", "methods_commit": "fixture",
                "manifest_commit": "fixture", "results_commit": "fixture",
                "generated_at": _iso_time(int(os.environ.get("SOURCE_DATE_EPOCH") or FIXTURE_EPOCH))}
    return {"registry_name": "txresbench-methods",
            "methods_commit": git_head(registry.root / "methods"),
            "manifest_commit": git_head(registry.root),
            "results_commit": git_head(registry.root),
            "generated_at": _iso_time(int(os.environ.get("SOURCE_DATE_EPOCH")
                                           or datetime.datetime.now(datetime.timezone.utc).timestamp()))}


def _iso_time(epoch):
    return datetime.datetime.fromtimestamp(epoch, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _int_or(v, default):
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return default


def _bool_of(v):
    return str(v).strip().lower() in ("true", "1", "yes")


def build_catalogue(registry, marker_groups_tsv, model_warnings_tsv):
    registry.check()
    manifest = load_manifest(registry.manifest)
    gates = load_gates(registry.gates_dir)
    mindraws = load_mindraws(registry.mindraws_dir)
    names, map_rows = load_catalog_markers(registry.catalog_dir)
    tsv = load_tsv_rows(marker_groups_tsv)
    warnings = {r["method_id"]: r["embeds_training_data"] for r in load_warnings(model_warnings_tsv)}
    group_map = {(r["system"], r["id"]): r for r in tsv}

    timings = load_timings(registry.runs_csv)
    run_ids = sorted(m for m, g in gates.items() if g.get("pass") and g.get("image_digest"))
    perf = load_performance(registry.scores_csv, set(run_ids))
    paper_titles = (load_paper_titles(registry.literature_md_dir)
                    if registry.literature_md_dir is not None else {})

    # pre-pass: collect required (system, id) pairs -> vocabulary; keep the manifest's original
    # id casing for display (the match key is case-folded, the shipped id is not)
    used_required = collections.Counter()
    required_case = {}
    pre = {}
    for mid in run_ids:
        mj = read_method_json(registry, mid)
        if mj is None:
            continue
        pre[mid] = mj
        for m in (mj.get("required_markers") or {}).get("markers") or []:
            if m.get("id"):
                rid = str(m.get("id") or "").strip()
                key = (str(m.get("id_system") or "other").lower(), rid.lower())
                used_required[key] += 1
                required_case.setdefault(key, rid)

    markers = build_vocabulary(used_required, required_case, names, map_rows, group_map)

    methods = []
    warnings_out = []
    for mid in run_ids:
        mj = pre.get(mid)
        if mj is None:
            warnings_out.append(f"{mid}: no method.json — skipped")
            continue
        row = manifest.get(mid, {})
        md = mindraws.get(mid, {})
        gate = gates[mid]
        group = (row.get("group") or mj.get("group") or "other")
        if group not in GROUP_LABELS:
            warnings_out.append(f"{mid}: unknown group {group!r} — label falls back to the group id")
        language = str(mj.get("language") or "other")
        kind, count = _marker_kind(mj.get("markers", "any"), mj.get("required_markers"))
        rm = mj.get("required_markers") or {}
        rm_markers = [m for m in rm.get("markers") or [] if m.get("id")]
        req_norm = {
            "markers": [{"name": str(m.get("name") or ""), "id_system": str(m.get("id_system") or "other"),
                         "id": str(m.get("id") or "").strip()} for m in rm_markers],
            "match": rm.get("match") or "all",
            "min_fraction": float(rm.get("min_fraction") or 0.0),
            "list_source": str(rm.get("list_source") or ""),
        }
        required_keyed = [(str(m.get("id_system") or "other").lower(), str(m.get("id") or "").strip().lower())
                          for m in rm_markers]
        needs_detection = _needs_detection_call(rm_markers)
        groups_required = _marker_groups_required(mj, md, required_keyed, group_map)
        min_draws = md.get("technical_min_draws")
        if not isinstance(min_draws, int):
            min_draws = int(mj.get("min_draws") or 1)
        methods.append({
            "id": mj["id"],
            "version": str(mj.get("version") or ""),
            "group": group,
            "group_label": GROUP_LABELS.get(group, group),
            "title": derive_title(mid, mj.get("description") or ""),
            "summary": derive_summary(mj.get("description") or ""),
            "paper_title": derive_paper_title(row.get("paper_doi"), mj.get("references"), paper_titles),
            "journal": row.get("journal") or "",
            "year": _int_or(row.get("year"), 0),
            "citations": _int_or(row.get("citations_all_papers"), 0),
            "language": language,
            "paper_doi": row.get("paper_doi") or "",
            "spec_status": str(row.get("spec_status") or "draft"),
            "frozen_model": _bool_of(row.get("frozen_model")),
            "container": _bool_of(row.get("container")),
            "runnable": True,
            "gate": {"pass": bool(gate.get("pass")),
                     "report_name": Path(str(gate.get("report") or "")).name},
            "env": {"image": f"{REGISTRY_PREFIX}/txresbench-{mid}:{mj.get('version')}",
                    "digest": str(gate.get("image_digest") or ""), "contract": CONTRACT},
            "markers": {"kind": kind, "count": count},
            "covariates": str(mj.get("covariates") or "none"),
            "min_draws": min_draws,
            "needs_baseline": md.get("needs_baseline") if isinstance(md.get("needs_baseline"), bool) else False,
            "uses_history": str(mj.get("uses_history") or "landmark"),
            "fitted": bool(mj.get("fitted")),
            "saves_model": bool(mj.get("saves_model")),
            "own_outputs": [str(x) for x in (mj.get("own_outputs") or [])],
            "tasks": _task_list(row.get("tasks")),
            "required_markers": req_norm if rm_markers else None,
            "needs_detection_call": needs_detection,
            "marker_groups_required": groups_required,
            "description": str(mj.get("description") or ""),
            "software": (mj.get("software") or {"language": "", "packages": {}}),
            "licence": str(mj.get("licence") or ""),
            "references": [str(x) for x in (mj.get("references") or [])],
            "params": (mj.get("params") or {}),
            "timing": _timing_for(mid, timings, language),
            "performance": _performance_for(mid, perf),
            "embeds_training_data": bool(warnings.get(mid, False)),
        })

    return {
        "schema_version": SCHEMA_VERSION,
        "generated_from": _provenance(registry),
        "methods": methods,
        "markers": markers,
        "groups": [{"id": gid, "display_name": label} for gid, label in BOARD_GROUPS],
    }, warnings_out


def dump_to_text(doc):
    hits = hygiene_scan(doc)
    if hits:
        raise ValueError("catalogue hygiene failed:\n  " + "\n  ".join(hits[:20]))
    return json.dumps(doc, indent=1, sort_keys=True) + "\n"


def selftest(fixtures_dir):
    """TEST-MC-15 / TEST-MC-16 invariants against the synthetic fixture registry."""
    registry = Registry(fixtures_dir, is_fixture=True)
    catalogue, _wrn = build_catalogue(registry, SCRIPT_DIR / "marker-groups.tsv",
                                      SCRIPT_DIR / "model-warnings.tsv")
    checks = []

    def check(name, cond, detail=""):
        checks.append((name, bool(cond), detail))

    ids = [m["id"] for m in catalogue["methods"]]
    check("methods are exactly the three fixture methods and sorted",
          ids == sorted({"fx-baseline-cox", "fx-asm-methylation-panel", "fx-response-signature"}), str(ids))
    check("generated_from carries fixture commits (no URLs/machine paths)",
          all(catalogue["generated_from"][k] == "fixture" for k in
              ("methods_commit", "manifest_commit", "results_commit")))
    group_ids = [g["id"] for g in catalogue["groups"]]
    check("groups are exactly the seven board groups", group_ids == BOARD_GROUP_IDS, str(group_ids))
    check("vocabulary has >= 2 markers", len(catalogue["markers"]) >= 2, str(len(catalogue["markers"])))
    check("no required field is null in a method entry",
          all(m["id"] and isinstance(m["version"], str) and m["group"] and m["group_label"]
              and m["env"]["image"] and m["env"]["digest"] and isinstance(m["min_draws"], int)
              and isinstance(m["embeds_training_data"], bool) for m in catalogue["methods"]))
    check("human-name fields: title + summary non-empty and within the caps; "
          "paper_title null without a literature store (the fixture registry ships none)",
          all(m["title"] and len(m["title"]) <= MAX_TITLE_CHARS
              and m["summary"] and len(m["summary"]) <= MAX_SUMMARY_CHARS
              and m["paper_title"] is None for m in catalogue["methods"]),
          str([(m["id"], len(m["title"]), len(m["summary"])) for m in catalogue["methods"]
               if not m["title"] or len(m["title"]) > MAX_TITLE_CHARS
               or not m["summary"] or len(m["summary"]) > MAX_SUMMARY_CHARS]))
    check("runnable implies env fields",
          all(m["runnable"] and m["env"]["image"] and m["env"]["digest"] for m in catalogue["methods"]))
    by_id = {(m["system"].lower(), m["id"].lower()): m for m in catalogue["markers"]}
    eya4 = by_id.get(("hgnc", "eya4"))
    cmea = by_id.get(("loinc", "2039-6"))
    unmapped = by_id.get(("other", "nlr_fixture"))
    check("marker-groups.tsv maps the fixture methylation marker",
          eya4 is not None and eya4["groups"] == ["methylation-sequencing"], str(eya4 and eya4["groups"]))
    check("the curated tsv maps CEA to tumour-markers",
          cmea is not None and cmea["groups"] == ["tumour-markers"], str(cmea and cmea["groups"]))
    check("an unmapped marker id lands in group other",
          unmapped is not None and unmapped["groups"] == ["other"], str(unmapped and unmapped["groups"]))
    check("vocabulary markers carry system/display_name/unit_family",
          all(m["system"] and m["display_name"] and m["unit_family"] for m in catalogue["markers"]))
    fx = {m["id"]: m for m in catalogue["methods"]}
    check("fx-baseline-cox timing is the runs.csv median (60.0)",
          fx["fx-baseline-cox"]["timing"]["base_seconds_per_fold"] == 60.0
          and fx["fx-baseline-cox"]["timing"]["quality"] == "measured",
          str(fx["fx-baseline-cox"]["timing"]))
    check("fx-response-signature timing falls back to the language default",
          fx["fx-response-signature"]["timing"]["quality"] == "estimate"
          and fx["fx-response-signature"]["timing"]["base_seconds_per_fold"] == 120.0,
          str(fx["fx-response-signature"]["timing"]))
    check("fx-baseline-cox performance medians from scores.csv",
          fx["fx-baseline-cox"]["performance"]["c_index_median"] == 0.725
          and fx["fx-baseline-cox"]["performance"]["auc_rule_median"] == 0.65
          and fx["fx-baseline-cox"]["performance"]["n_units"] == 2,
          str(fx["fx-baseline-cox"]["performance"]))
    check("fx-response-signature performance is null (no primary c_index rows)",
          fx["fx-response-signature"]["performance"] is None)
    check("model-warnings.tsv maps embeds_training_data",
          fx["fx-response-signature"]["embeds_training_data"] is True
          and fx["fx-baseline-cox"]["embeds_training_data"] is False,
          str((fx["fx-response-signature"]["embeds_training_data"],
               fx["fx-baseline-cox"]["embeds_training_data"])))
    check("required markers + fixture panel shape",
          fx["fx-asm-methylation-panel"]["markers"]["kind"] == "panel"
          and fx["fx-asm-methylation-panel"]["markers"]["count"] == 2
          and fx["fx-asm-methylation-panel"]["required_markers"]["match"] == "all"
          and set(fx["fx-asm-methylation-panel"]["marker_groups_required"]) == {"methylation-sequencing"},
          str((fx["fx-asm-methylation-panel"]["markers"],
               fx["fx-asm-methylation-panel"]["marker_groups_required"])))
    check("single/any marker kinds",
          fx["fx-response-signature"]["markers"]["kind"] == "single"
          and fx["fx-baseline-cox"]["markers"]["kind"] == "any")
    check("fixture detection call is false (no detection-named required marker)",
          all(not m["needs_detection_call"] for m in catalogue["methods"]))
    check("detection-named required markers set needs_detection_call",
          _needs_detection_call([{"name": "ctDNA detection status call"}]) is True
          and _needs_detection_call([{"name": "marker detectability level"}]) is True
          and _needs_detection_call([{"name": "CEA concentration (ng/mL)"}]) is False)
    doc = sanitize_value(catalogue)
    check("sanitized catalogue is free of urls/stud/status tokens",
          hygiene_scan(doc) == [], " ".join(hygiene_scan(doc))[:300])
    check("sanitizer removed the fixture's deliberate 'study' + url",
          "study" not in str(doc) and "example.invalid" not in str(doc))
    ok = all(c[1] for c in checks)
    for name, passed, detail in checks:
        print(("PASS" if passed else "FAIL") + f"  {name}" + (f"  [{detail}]" if detail and not passed else ""))
    print(("self-test OK" if ok else "self-test FAILED") + f"  ({len(catalogue['methods'])} fixture methods)")
    return 0 if ok else 1


def _normalise(doc):
    """--check probe: the data must match; generated_at is provenance, never a parity failure."""
    import copy
    d = copy.deepcopy(doc)
    d.get("generated_from", {}).pop("generated_at", None)
    return d


def backfill_human_names(target, root):
    """qa-fixes3 ITEM-1: add the three human-name fields to the COMMITTED
    catalogue without regenerating it. The benchmark tree is live-edited, so a
    full regen would silently resnapshot fields this item does not touch
    (timing/performance/marker vocabulary — 656 field instances and 800 new
    markers today), and the regen runbook reserves the live-tree run for the
    owner. This mode derives the three fields from the SAME rules (the
    generators' own functions below) and rewrites nothing else; the derived
    facts are snapshot-consistent because the descriptions were verified to
    match the committed bytes (a method whose method.json is absent keeps its
    committed description as the derivation source)."""
    doc = json.loads(target.read_text(encoding="utf-8"))
    manifest = load_manifest(Registry(root, is_fixture=False).manifest)
    titles = load_paper_titles(Registry(root, is_fixture=False).literature_md_dir)
    for m in doc["methods"]:
        mid = m["id"]
        mj = read_method_json(Registry(root, is_fixture=False), mid) or {}
        description = str(mj.get("description") or m.get("description") or "")
        m["title"] = derive_title(mid, description)
        m["summary"] = derive_summary(description)
        m["paper_title"] = derive_paper_title(
            (manifest.get(mid) or {}).get("paper_doi"), mj.get("references"), titles)
    text = dump_to_text(doc)
    target.write_text(text, encoding="utf-8")
    print(f"human names backfilled into {target}: {len(doc['methods'])} methods")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Generate the TxResBench method catalogue (data/method-catalogue/catalogue.json)")
    ap.add_argument("--out", default=str(DEFAULT_CATALOGUE))
    ap.add_argument("--fixtures", action="store_true", help="use the synthetic fixture registry")
    ap.add_argument("--check", action="store_true", help="generate and byte-compare with the target file")
    ap.add_argument("--selftest", action="store_true", help="run the generator invariants (TEST-MC-15/16)")
    ap.add_argument("--propose-groups", action="store_true", help="write a marker-groups proposal tsv")
    ap.add_argument("--human-names", action="store_true",
                    help="backfill the title/summary/paper_title fields of the committed catalogue "
                         "without a full regeneration (the live-tree regen is the owner's runbook step)")
    ap.add_argument("--root", default=os.environ.get("SIGTRANS_ROOT", str(DEFAULT_SIGTRANS_ROOT)),
                    help="benchmark tree root (default SIGTRANS_ROOT or /data/share/pbya/sigtrans)")
    a = ap.parse_args(argv)

    if a.selftest:
        return selftest(SCRIPT_DIR / "fixtures")

    if a.human_names:
        return backfill_human_names(Path(a.out), Path(a.root))

    registry = Registry(SCRIPT_DIR / "fixtures" if a.fixtures else Path(a.root), is_fixture=a.fixtures)
    catalogue, warnings_out = build_catalogue(registry, SCRIPT_DIR / "marker-groups.tsv",
                                              SCRIPT_DIR / "model-warnings.tsv")
    for w in warnings_out:
        print(f"warning: {w}")

    if a.propose_groups:
        prop = SCRIPT_DIR / "marker-groups.proposed.tsv"
        with open(prop, "w", encoding="utf-8") as f:
            f.write("# AUTO-PROPOSED (curate before committing; the committed marker-groups.tsv is hand-confirmed)\n")
            f.write("system\tid\tgroup\tunit_family\tcanonical_unit\n")
            for m in catalogue["markers"]:
                f.write(f"{m['system'].lower()}\t{m['id']}\t{m['groups'][0]}\t{m['unit_family']}\t{m['canonical_unit']}\n")
        print(f"proposal written: {prop}")

    if a.check:
        target = DEFAULT_FIXTURE_EXPECTATION if a.fixtures else Path(a.out)
        doc = sanitize_value(catalogue)
        fresh = dump_to_text(doc)
        if not target.exists():
            print(f"check: {target} does not exist")
            return 1
        old = target.read_text(encoding="utf-8")
        # fixture parity is byte-exact (SOURCE_DATE_EPOCH-deterministic); the real-mode parity
        # compares the data with generated_at neutralized (provenance, not data)
        old_doc, fresh_doc = _normalise(json.loads(old)), _normalise(doc)
        if old != fresh and a.fixtures:
            print(f"check: {target} is stale (fresh fixture generation differs)")
            return 1
        if old_doc != fresh_doc:
            print(f"check: {target} is stale (fresh generation differs)")
            return 1
        print(f"check: {target} matches a fresh generation ({len(doc['methods'])} methods, "
              f"{len(doc['markers'])} markers)")
        return 0

    doc = sanitize_value(catalogue)
    text = dump_to_text(doc)
    Path(a.out).write_text(text, encoding="utf-8")
    print(f"wrote {a.out}: {len(doc['methods'])} methods, {len(doc['markers'])} markers, "
          f"{len(doc['groups'])} groups")
    return 0


if __name__ == "__main__":
    sys.exit(main())
