#!/usr/bin/env python3
"""Build the TxResBench app's method catalogue (method-catalogue node, generator part).

Reads the BENCHMARK tree at BUILD time only (INV-1: the app ships its own copy, generated
by a script, never read at run time) and writes the single committed catalogue file
`data/method-catalogue/catalogue.json` (PROV-MC-1, schema version 2). Inputs follow DECISIONS.md
DEC-1: the per-method package manifests (`methods/methods/<id>/method.json`), the gate results
(`methods/gates/<id>.json`), the registry facts (`dev/code/manifest/methods.csv`), the curated
draw facts (`dev/code/benchmark/schema/per-method/mindraws/*.json`), the curated marker
vocabulary (`dev/analysis-catalog/datasets/*/{markers,mapping}.yaml`), the benchmark's own
stored aggregate results (`results/benchmark/{runs,scores}.csv`), and — schema version 2 —
the filter facts: the benchmark's disease assertions (`site/public/data/methods.json`,
`biomarkers.defined_for`), the disease categories
(`dev/analysis-catalog/disease_group_categories.csv` + the repo's
`disease-categories-extra.tsv` rows the benchmark file lacks), the one-level disease
parents (`disease-parents.tsv`) and the treatment mapping (`method-treatment.tsv`,
`treatment-classes.tsv`, `treatment-base-classes.tsv` — all repo tables under
`scripts/method-catalogue/`). The candidate spec YAMLs stay out (DEC-1). The runnable set only
is emitted (DEC-2).

filter_options ordering (schema 2): the curated tables give the order, so the CSV/TSV rows are
emitted in first-seen order — categories and diseases per the categories CSV (with the extra
table's rows appended after the CSV's per category, in extra-file order), children per the
parents TSV, and treatment classes per the display order of treatment-base-classes.tsv. A
group the categories file lists that disease-parents.tsv names as a CHILD is not a
disease-level entry (the benchmark's CSV lists children too): it goes under its parent only,
and its category must equal its parent's. Every
disease/child/class id is unique (the Rust loader refuses duplicates at boot).

Usage:
    python3 scripts/method-catalogue/gen_method_catalogue.py [--out data/method-catalogue/catalogue.json]
        --fixtures        read the synthetic fixture registry (scripts/method-catalogue/fixtures/)
                          instead of SIGTRANS_ROOT; deterministic commits + generated_at
        --check           regenerate and byte-compare with the target file; exit 1 on a mismatch
                          (real mode: data/method-catalogue/catalogue.json; fixture mode:
                          scripts/method-catalogue/fixtures/expected-catalogue.json)
        --selftest        run the generator's own invariant checks against the fixture registry
                          (TEST-MC-15/TEST-MC-16) and exit 0/1
        --only ID --previous CATALOGUE --methods-dir METHODS [--images FILE] [--revision COMMIT]
                          one-method mode (the method list's catalogue in the methods repository,
                          method-list/catalogue.json): rebuild or add one row, reading method.json
                          and gates/<id>.json from the methods repository at the image entries'
                          source_revision (the newest, when the arches were built at several
                          commits of one method folder); every other row is carried byte for byte, missing
                          vocabulary markers are added, n_methods is recounted, and the rebuilt row's
                          disease/treatment facts and the filter_options block are refreshed from the
                          benchmark tree; writes --previous in place unless --out is given
        --filter-facts --previous CATALOGUE [--out FILE]
                          schema-2 upgrade mode (how the shipped catalogue is migrated): rewrite
                          ONLY `disease`/`treatment` on every row and the `filter_options` block,
                          set `schema_version` 2, and carry everything else (row order,
                          generated_at, every other field) byte for byte
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

SCHEMA_VERSION = 2
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


# ---- schema-2 filter facts (disease, treatment) -------------------------------
# Every fact below is read at BUILD time only (INV-1). The disease facts come from the
# benchmark's site/public/data/methods.json (biomarkers.defined_for), the disease categories
# from the benchmark's dev/analysis-catalog/disease_group_categories.csv plus the repo's
# disease-categories-extra.tsv, the one-level children from disease-parents.tsv and the
# treatment mapping from method-treatment.tsv / treatment-classes.tsv /
# treatment-base-classes.tsv (the repo tables under scripts/method-catalogue/).
DISEASE_SCOPES = ("group", "any", "any-solid-tumour", "any-cancer")
TREATMENT_CONFIDENCES = ("stated", "inferred", "not-stated")
# The defined_for phrases that are scopes, not disease names.
_DEFINED_FOR_SCOPES = {
    "any disease": "any",
    "any cancer": "any-cancer",
    "any solid tumour": "any-solid-tumour",
}
# Breadth: `any` (every disease) covers any-cancer, which covers any-solid-tumour.
_SCOPE_BREADTH = {"any": 0, "any-cancer": 1, "any-solid-tumour": 2}


def _tsv_rows(path, ncols, description, allow_empty=False):
    """TSV rows of a table: comment lines (`#`), the header line, then the data rows."""
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            # Strip only the line end: a trailing empty field (an empty
            # base-class list) is a real column, not whitespace.
            line = line.rstrip("\r\n")
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) < ncols:
                raise ValueError(f"{path}: malformed {description} row {line!r}")
            rows.append(parts)
    if not rows and not allow_empty:
        raise ValueError(f"{path}: {description} has no data rows")
    return rows


def load_methods_json(path):
    """The benchmark's disease-assertion file: {method_id: ["disease", ...]} from
    `biomarkers.defined_for`. Duplicate ids and non-list defined_for are hard errors."""
    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    methods = doc.get("methods") if isinstance(doc, dict) else None
    if not isinstance(methods, list):
        raise ValueError(f"{path}: expected a JSON object with a `methods` list")
    out = {}
    for m in methods:
        if not isinstance(m, dict) or not m.get("id"):
            raise ValueError(f"{path}: a methods entry is missing its id")
        mid = str(m["id"])
        if mid in out:
            raise ValueError(f"{path}: duplicate method id {mid!r}")
        defined = ((m.get("biomarkers") or {}).get("defined_for") or [])
        if not isinstance(defined, list):
            raise ValueError(f"{path}: method {mid} has a non-list biomarkers.defined_for")
        out[mid] = [str(d).strip() for d in defined]
    return out


def load_disease_categories(csv_path, extra_tsv_path):
    """The disease vocabulary: (categories, disease_set, category_of), where `categories` is an
    OrderedDict category -> OrderedDict disease (first-seen order — the curated tables'
    order is the filter_options order), `disease_set` is every name the two tables list (a
    child that disease-parents.tsv names may be listed here too — the benchmark's CSV does)
    and `category_of` is disease -> category for the same set (the child-level rule compares
    a child's category against its parent's)."""
    categories = collections.OrderedDict()
    disease_set = set()
    category_of = {}

    def add(disease_group, category, source):
        if disease_group in disease_set:
            raise ValueError(f"{source}: disease {disease_group!r} appears in two categories")
        disease_set.add(disease_group)
        category_of[disease_group] = category
        categories.setdefault(category, collections.OrderedDict()).setdefault(disease_group, None)

    with open(csv_path, encoding="utf-8", newline="") as f:
        for parts in csv.reader(f):
            if not parts or parts[0].startswith("#"):
                continue
            parts = [p.strip() for p in parts]
            if not parts or not parts[0]:
                continue
            if parts[0].lower() in ("disease_group", "disease group"):
                continue  # header
            if len(parts) < 2:
                raise ValueError(f"{csv_path}: malformed row {','.join(parts)!r}")
            add(parts[0], parts[1], csv_path)
    for parts in _tsv_rows(extra_tsv_path, 2, "disease-categories-extra", allow_empty=True):
        if parts[0].lower() in ("disease_group", "disease group"):
            continue  # header
        add(parts[0], parts[1], extra_tsv_path)
    return categories, disease_set, category_of


def load_disease_parents(tsv_path, disease_set, disease_category):
    """The one-level disease parents: OrderedDict parent -> [children in first-seen order],
    plus the child set. Hard errors: a duplicate child under two parents, a cycle, a parent
    that is itself a child (a deeper chain), a parent that is not a known group (in neither
    the categories file nor the extra table), and a child the categories file lists under a
    category different from its parent's. A child that the categories file also lists as a
    group is NOT an error — the benchmark's CSV does exactly that — it just sits below the
    disease level (its category must match its parent's)."""
    children = collections.OrderedDict()
    child_parent = {}
    child_order = []
    parents_set = set()
    for parts in _tsv_rows(tsv_path, 2, "disease-parents"):
        child, parent = parts[0], parts[1]
        if child.lower() in ("disease_group", "disease group"):
            continue  # header
        if child in child_parent and child_parent[child] != parent:
            raise ValueError(f"{tsv_path}: child {child!r} appears under two parents "
                             f"({child_parent[child]!r} and {parent!r})")
        if child not in child_parent:
            child_parent[child] = parent
            child_order.append(child)
            children.setdefault(parent, collections.OrderedDict()).setdefault(child, None)
            parents_set.add(parent)
    # A cycle (a child chain that loops) is reported before the flat one-level rule.
    for start in child_order:
        seen = set()
        node = start
        while node in child_parent:
            if node in seen:
                chain = " -> ".join(list(seen) + [node])
                raise ValueError(f"{tsv_path}: disease-parent cycle: {chain}")
            seen.add(node)
            node = child_parent[node]
    # One level only: a parent that is itself a child (a deeper chain) is a hard error.
    for child, parent in child_parent.items():
        if child in parents_set:
            raise ValueError(f"{tsv_path}: {child!r} is both a child (of {parent!r}) and a "
                             "parent — one level only")
    # Every parent is a known group (a child without a disease would be orphaned).
    for parent in parents_set:
        if parent not in disease_set:
            raise ValueError(f"{tsv_path}: parent_group {parent!r} is not a known disease "
                             "group (in neither disease_group_categories.csv nor "
                             "disease-categories-extra.tsv)")
    # A child the categories file also lists as a group is NOT a second disease: it sits under
    # its parent only, so its category must be the parent's category. A child the categories
    # file does not list gets its category from the parent (nothing to compare).
    for child in child_order:
        parent = child_parent[child]
        child_category = disease_category.get(child)
        if child_category is not None and child_category != disease_category[parent]:
            raise ValueError(f"{tsv_path}: child {child!r} has category {child_category!r} but "
                             f"its parent {parent!r} has category {disease_category[parent]!r} "
                             "— a child sits below its parent and shares its category")
    return {p: [c for c in children.get(p, {})] for p in children}, set(child_order)


def load_treatment_facts(method_treatment_tsv, treatment_classes_tsv, base_classes_tsv):
    """The treatment mapping: (per_method, base_classes, class_to_bases), where per_method is
    {method_id: {"class": benchmark_class, "confidence": ...}}, base_classes is the closed
    [(id, label)] in display order and class_to_bases is benchmark_class -> [base ids]."""
    base_classes = []
    seen = set()
    for parts in _tsv_rows(base_classes_tsv, 2, "treatment-base-classes"):
        if parts[0].lower() in ("id", "class", "class_id"):
            continue  # header
        cid, label = parts[0], parts[1]
        if cid in seen:
            raise ValueError(f"{base_classes_tsv}: duplicate base class {cid!r}")
        seen.add(cid)
        base_classes.append((cid, label))
    class_to_bases = {}
    for parts in _tsv_rows(treatment_classes_tsv, 2, "treatment-classes"):
        bench, raw = parts[0], parts[1]
        if bench.lower() in ("benchmark_class", "benchmark class", "class"):
            continue  # header
        if bench in class_to_bases:
            raise ValueError(f"{treatment_classes_tsv}: duplicate benchmark class {bench!r}")
        bases = [b.strip() for b in raw.split(";")] if raw.strip() else []
        for b in bases:
            if b not in seen:
                raise ValueError(f"{treatment_classes_tsv}: base class {b!r} (of {bench!r}) is "
                                 f"not in {base_classes_tsv}")
        class_to_bases[bench] = sorted({b for b in bases if b})
    per_method = {}
    for parts in _tsv_rows(method_treatment_tsv, 5, "method-treatment"):
        mid, bench, confidence = parts[0], parts[1], parts[2]
        if mid.lower() in ("method_id", "method"):
            continue  # header
        if confidence not in TREATMENT_CONFIDENCES:
            raise ValueError(f"{method_treatment_tsv}: method {mid} has unknown confidence "
                             f"{confidence!r} (stated|inferred|not-stated)")
        if bench not in class_to_bases:
            raise ValueError(f"{method_treatment_tsv}: method {mid} names benchmark class "
                             f"{bench!r}, which is not in {treatment_classes_tsv}")
        if mid in per_method:
            raise ValueError(f"{method_treatment_tsv}: duplicate row for method {mid!r}")
        per_method[mid] = {"class": bench, "confidence": confidence}
    return per_method, base_classes, class_to_bases


def load_filter_tables(registry):
    """The schema-2 filter facts of one registry (fixture or benchmark tree): the raw tables
    plus the derived lookups the row builder reads. The child level is below the disease
    level: even when the categories file (or the extra table) lists a child as a group — the
    benchmark's CSV does — it is not a disease-level entry, so `categories` and `disease_set`
    hold only the parents."""
    methods_json = load_methods_json(registry.methods_json)
    categories, disease_set, disease_category = load_disease_categories(
        registry.disease_categories_csv, registry.disease_categories_extra)
    parents, child_set = load_disease_parents(registry.disease_parents, disease_set,
                                              disease_category)
    disease_set = disease_set - child_set
    categories = collections.OrderedDict(
        (category, collections.OrderedDict(
            (disease, None) for disease in diseases if disease not in child_set))
        for category, diseases in categories.items())
    per_method, base_classes, class_to_bases = load_treatment_facts(
        registry.method_treatment, registry.treatment_classes, registry.treatment_base_classes)
    return {
        "methods_json": methods_json,
        "categories": categories,
        "disease_set": disease_set,
        "parents": parents,
        "child_set": child_set,
        "treatment": per_method,
        "base_classes": base_classes,
        "class_to_bases": class_to_bases,
    }


def disease_for(facts, mid, runnable, warnings_out):
    """One method's disease fact. A runnable method missing from methods.json is a hard
    error (the catalogue must carry a fact for every runnable row); a non-runnable row
    missing from it gets scope `any` and a warning. A `defined_for` list mixing an `any…`
    phrase with disease names uses the broadest `any…` scope and drops the names."""
    entry = facts["methods_json"].get(mid)
    if entry is None:
        if runnable:
            raise ValueError(f"DISEASE_UNKNOWN: runnable method {mid} is not in methods.json "
                             "(the benchmark's site/public/data/methods.json)")
        warnings_out.append(f"{mid}: not in methods.json (not runnable) — disease scope any")
        return {"scope": "any", "groups": []}
    any_scopes = [_DEFINED_FOR_SCOPES[d] for d in entry if d in _DEFINED_FOR_SCOPES]
    names = [d for d in entry if d not in _DEFINED_FOR_SCOPES]
    if any_scopes:
        return {"scope": min(any_scopes, key=lambda s: _SCOPE_BREADTH[s]), "groups": []}
    if not names:
        raise ValueError(f"DISEASE_UNDEFINED: method {mid} has an empty biomarkers.defined_for "
                         "in methods.json")
    groups = sorted({str(g).strip() for g in names})
    for g in groups:
        if g not in facts["disease_set"] and g not in facts["child_set"]:
            raise ValueError(f"DISEASE_UNGROUPED: disease name {g!r} used by method {mid} is in "
                             "neither disease_group_categories.csv nor disease-parents.tsv")
    return {"scope": "group", "groups": groups}


def treatment_for(facts, mid, warnings_out):
    """One method's treatment fact: the base classes its benchmark class maps to (sorted,
    unique), confidence from the table — `not-stated` whenever the classes are empty. A
    method missing from method-treatment.tsv is `not-stated` with a warning."""
    entry = facts["treatment"].get(mid)
    if entry is None:
        warnings_out.append(f"{mid}: no row in method-treatment.tsv — treatment not stated")
        return {"classes": [], "confidence": "not-stated"}
    confidence = entry["confidence"]
    classes = facts["class_to_bases"].get(entry["class"], [])
    if confidence != "not-stated" and not classes:
        warnings_out.append(f"{mid}: treatment class {entry['class']!r} maps to no base class in "
                            "treatment-classes.tsv — confidence not-stated")
    if confidence != "not-stated" and classes:
        return {"classes": sorted(set(classes)), "confidence": confidence}
    return {"classes": [], "confidence": "not-stated"}


def filter_options_for(facts):
    """The `filter_options` block: the categories table's diseases (with their one-level
    children) in table order, and the closed treatment base classes in display order."""
    return {
        "disease_categories": [
            {"id": category, "diseases": [
                {"id": disease, "children": list(facts["parents"].get(disease, []))}
                for disease in diseases]}
            for category, diseases in facts["categories"].items()],
        "treatment_classes": [{"id": cid, "label": label}
                              for cid, label in facts["base_classes"]],
    }


def validate_row_filter_facts(methods, facts, where="previous"):
    """Every carried row's disease/treatment facts must name known filter_options entries and
    keep the scope/confidence discipline — the Rust loader refuses a catalogue that breaks it
    at boot, so the generator fails HERE with a named error."""
    disease_ids = facts["disease_set"] | facts["child_set"]
    class_ids = {cid for cid, _ in facts["base_classes"]}
    for m in methods:
        mid = m.get("id")
        d = m.get("disease") or {}
        if d.get("scope") not in DISEASE_SCOPES:
            raise ValueError(f"{where} catalogue row {mid}: unknown disease scope {d.get('scope')!r}")
        if (d.get("scope") == "group") != bool(d.get("groups")):
            raise ValueError(f"{where} catalogue row {mid}: disease scope {d.get('scope')!r} "
                             f"and groups {d.get('groups')!r} disagree")
        for g in d.get("groups") or []:
            if g not in disease_ids:
                raise ValueError(f"{where} catalogue row {mid}: disease group {g!r} is not a "
                                 "disease or a child in filter_options")
        t = m.get("treatment") or {}
        if t.get("confidence") not in TREATMENT_CONFIDENCES:
            raise ValueError(f"{where} catalogue row {mid}: unknown treatment confidence "
                             f"{t.get('confidence')!r}")
        if (t.get("confidence") == "not-stated") != (not t.get("classes")):
            raise ValueError(f"{where} catalogue row {mid}: treatment confidence "
                             f"{t.get('confidence')!r} and classes {t.get('classes')!r} disagree")
        for c in t.get("classes") or []:
            if c not in class_ids:
                raise ValueError(f"{where} catalogue row {mid}: treatment class {c!r} is not an "
                                 "id of filter_options.treatment_classes")
    return methods


def build_filter_facts(doc, facts, warnings_out):
    """`--filter-facts`: the previous catalogue (schema 1 or 2) with ONLY `disease`/`treatment`
    on every row and the `filter_options` block rewritten, `schema_version` set to 2; row
    order, `generated_at` and every other field are carried untouched."""
    rows = []
    for m in doc["methods"]:
        m = dict(m)
        m["disease"] = disease_for(facts, m["id"], bool(m.get("runnable", True)), warnings_out)
        m["treatment"] = treatment_for(facts, m["id"], warnings_out)
        rows.append(m)
    out = dict(doc)
    out["methods"] = rows
    out["schema_version"] = SCHEMA_VERSION
    out["filter_options"] = filter_options_for(facts)
    return out


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
            # schema-2 filter-fact sources (fixture copies of the build-time inputs)
            self.methods_json = self.root / "methods.json"
            self.disease_categories_csv = self.root / "disease_group_categories.csv"
            self.disease_categories_extra = self.root / "disease-categories-extra.tsv"
            self.disease_parents = self.root / "disease-parents.tsv"
            self.method_treatment = self.root / "method-treatment.tsv"
            self.treatment_classes = self.root / "treatment-classes.tsv"
            self.treatment_base_classes = self.root / "treatment-base-classes.tsv"
        else:
            self.methods_dir = self.root / "methods" / "methods"
            self.gates_dir = self.root / "methods" / "gates"
            self.manifest = self.root / "dev" / "code" / "manifest" / "methods.csv"
            self.mindraws_dir = self.root / "dev" / "code" / "benchmark" / "schema" / "per-method" / "mindraws"
            self.catalog_dir = self.root / "dev" / "analysis-catalog" / "datasets"
            self.runs_csv = self.root / "results" / "benchmark" / "runs.csv"
            self.scores_csv = self.root / "results" / "benchmark" / "scores.csv"
            # schema-2 filter-fact sources: the benchmark's assertion file + category CSV, and
            # the repo tables (the extension/curation tables live with the generator)
            self.methods_json = self.root / "site" / "public" / "data" / "methods.json"
            self.disease_categories_csv = self.root / "dev" / "analysis-catalog" / "disease_group_categories.csv"
            self.disease_categories_extra = SCRIPT_DIR / "disease-categories-extra.tsv"
            self.disease_parents = SCRIPT_DIR / "disease-parents.tsv"
            self.method_treatment = SCRIPT_DIR / "method-treatment.tsv"
            self.treatment_classes = SCRIPT_DIR / "treatment-classes.tsv"
            self.treatment_base_classes = SCRIPT_DIR / "treatment-base-classes.tsv"
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


def load_inputs(registry, marker_groups_tsv, model_warnings_tsv):
    """Every benchmark-tree input except method.json and the gates' pass/digest selection
    (the full build reads those from the tree; the one-method mode reads method.json and the
    gate from the methods repository at the method's own commit)."""
    registry.check()
    names, map_rows = load_catalog_markers(registry.catalog_dir)
    tsv = load_tsv_rows(marker_groups_tsv)
    return {
        "manifest": load_manifest(registry.manifest),
        "gates": load_gates(registry.gates_dir),
        "mindraws": load_mindraws(registry.mindraws_dir),
        "names": names,
        "map_rows": map_rows,
        "warnings": {r["method_id"]: r["embeds_training_data"] for r in load_warnings(model_warnings_tsv)},
        "group_map": {(r["system"], r["id"]): r for r in tsv},
        "timings": load_timings(registry.runs_csv),
        "paper_titles": (load_paper_titles(registry.literature_md_dir)
                         if registry.literature_md_dir is not None else {}),
    }


def required_keys(mj):
    """The (system, id) match keys of a method's required markers, with the manifest's own id
    casing (the match key is case-folded, the shipped id is not)."""
    out = []
    for m in (mj.get("required_markers") or {}).get("markers") or []:
        if m.get("id"):
            rid = str(m.get("id") or "").strip()
            out.append(((str(m.get("id_system") or "other").lower(), rid.lower()), rid))
    return out


def method_row(mid, mj, gate, inputs, perf, warnings_out, facts):
    """One catalogue row. `build_vocabulary` must have run first (the marker-group fallback
    reads its alias map); `facts` is the loaded schema-2 fact tables (disease/treatment)."""
    row = inputs["manifest"].get(mid, {})
    md = inputs["mindraws"].get(mid, {})
    group_map = inputs["group_map"]
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
    return {
        "id": mj["id"],
        "version": str(mj.get("version") or ""),
        "group": group,
        "group_label": GROUP_LABELS.get(group, group),
        "title": derive_title(mid, mj.get("description") or ""),
        "summary": derive_summary(mj.get("description") or ""),
        "paper_title": derive_paper_title(row.get("paper_doi"), mj.get("references"),
                                          inputs["paper_titles"]),
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
        "timing": _timing_for(mid, inputs["timings"], language),
        "performance": _performance_for(mid, perf),
        "embeds_training_data": bool(inputs["warnings"].get(mid, False)),
        "disease": disease_for(facts, mid, True, warnings_out),
        "treatment": treatment_for(facts, mid, warnings_out),
    }


def build_catalogue(registry, marker_groups_tsv, model_warnings_tsv):
    inputs = load_inputs(registry, marker_groups_tsv, model_warnings_tsv)
    gates = inputs["gates"]
    run_ids = sorted(m for m, g in gates.items() if g.get("pass") and g.get("image_digest"))
    perf = load_performance(registry.scores_csv, set(run_ids))
    facts = load_filter_tables(registry)

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
        for key, rid in required_keys(mj):
            used_required[key] += 1
            required_case.setdefault(key, rid)

    markers = build_vocabulary(used_required, required_case, inputs["names"], inputs["map_rows"],
                               inputs["group_map"])

    methods = []
    warnings_out = []
    for mid in run_ids:
        mj = pre.get(mid)
        if mj is None:
            warnings_out.append(f"{mid}: no method.json — skipped")
            continue
        methods.append(method_row(mid, mj, gates[mid], inputs, perf, warnings_out, facts))

    return {
        "schema_version": SCHEMA_VERSION,
        "generated_from": _provenance(registry),
        "methods": methods,
        "markers": markers,
        "groups": [{"id": gid, "display_name": label} for gid, label in BOARD_GROUPS],
        "filter_options": filter_options_for(facts),
    }, warnings_out


# ---- one-method mode (`--only <id> --previous <catalogue> --methods-dir <methods>`) ----
# The method list's catalogue lives in the methods repository (method-list/catalogue.json) and
# changes one method at a time: one row is rebuilt, every other row is carried byte for byte (a
# full regeneration would also move every other method's timings and vocabulary with the live
# benchmark tree). The rebuilt row reads method.json and gates/<id>.json from the methods
# repository at the method's own commit (the image entry's `source_revision`), never from a
# checkout; the other inputs (registry facts, draws, timings, results, vocabulary) still come
# from the benchmark tree.
class OnlyModeError(Exception):
    pass


def _git(methods_dir, *args):
    try:
        return subprocess.run(["git", "-C", str(methods_dir), *args], capture_output=True, timeout=60)
    except (OSError, subprocess.SubprocessError) as e:
        raise OnlyModeError(f"ONLY_GIT: git failed in {methods_dir}: {e}") from e


def _git_json_at(methods_dir, commit, path):
    p = _git(methods_dir, "cat-file", "blob", f"{commit}:{path}")
    if p.returncode != 0:
        return None
    try:
        return json.loads(p.stdout)
    except ValueError as e:
        raise OnlyModeError(f"ONLY_BAD_JSON: {path} at {commit[:12]} is not valid JSON: {e}") from e


def _commit_of(methods_dir, rev):
    p = _git(methods_dir, "rev-parse", "--verify", "--quiet", rev + "^{commit}")
    commit = p.stdout.decode().strip() if p.returncode == 0 else ""
    if not re.match(r"^[0-9a-f]{40}$", commit):
        raise OnlyModeError(f"ONLY_COMMIT_UNKNOWN: commit {rev} is not in the methods repository "
                            f"{methods_dir} (fetch it)")
    return commit


def only_commit(mid, images, methods_dir, revision=None):
    """The methods commit a row is rebuilt at (full id).

    - `--revision`: that commit; when the method has image entries it must be one of their
      `source_revision`s (the row's facts are those its images were built from).
    - one `source_revision` among the method's entries: that commit.
    - several (each arch built on its own machine, at its own HEAD) that hold ONE method
      folder (`source_tree`): the newest of them (the others are its ancestors), so the gate
      file is the latest; commits not on one line, or different trees, need `--revision`.
    - no entry: `--revision` is required."""
    entries = [e for e in (images or {}).get("envs") or [] if e.get("method_id") == mid]
    revs = sorted({str(e.get("source_revision") or "") for e in entries})
    trees = sorted({str(e.get("source_tree") or "") for e in entries})
    if revision:
        commit = _commit_of(methods_dir, revision)
        if revs and commit[:12] not in revs:
            raise OnlyModeError(f"ONLY_REVISION_CONFLICT: {mid}'s image entries were built at "
                                f"{', '.join(revs)}, not at {commit[:12]}: --revision names one of "
                                "them (the row's facts are those its images were built from)")
        return commit
    if not revs:
        raise OnlyModeError(f"ONLY_NO_IMAGE_ENTRY: {mid} has no image entry to take its commit "
                            "from; pass --revision <methods commit>")
    if len(revs) == 1:
        return _commit_of(methods_dir, revs[0])
    if len(trees) != 1 or not trees[0]:
        raise OnlyModeError(f"ONLY_REVISION_AMBIGUOUS: {mid}'s image entries were built from "
                            f"different method folders (commits {', '.join(revs)}); pass "
                            "--revision <one of them>")
    commits = [_commit_of(methods_dir, r) for r in revs]
    for c in commits:
        if all(o == c or _git(methods_dir, "merge-base", "--is-ancestor", o, c).returncode == 0
               for o in commits):
            return c
    raise OnlyModeError(f"ONLY_REVISION_AMBIGUOUS: {mid}'s image entries were built at "
                        f"{', '.join(revs)}, which are not on one line; pass --revision "
                        "<one of them>")


def build_only(mid, previous, images, methods_dir, registry, marker_groups_tsv, model_warnings_tsv,
               revision=None):
    """`previous` with the row of `mid` rebuilt (or added) at its own commit, every other row
    carried as it is, vocabulary markers the row needs and the previous catalogue lacks added,
    and every marker's `n_methods` recounted over the rows. Returns (doc, warnings, commit)."""
    commit = only_commit(mid, images, methods_dir, revision)
    mj = _git_json_at(methods_dir, commit, f"methods/{mid}/method.json")
    if not isinstance(mj, dict):
        raise OnlyModeError(f"ONLY_METHOD_NOT_IN_COMMIT: methods/{mid}/method.json is not in "
                            f"commit {commit[:12]}")
    if mj.get("id") != mid:
        raise OnlyModeError(f"ONLY_METHOD_ID: methods/{mid}/method.json at {commit[:12]} has id "
                            f"{mj.get('id')!r}")
    gate = _git_json_at(methods_dir, commit, f"gates/{mid}.json")
    if not (isinstance(gate, dict) and gate.get("pass") is True and gate.get("image_digest")):
        raise OnlyModeError(f"ONLY_NOT_GATED: gates/{mid}.json at {commit[:12]} is missing or "
                            "does not pass with an image digest (only runnable methods get a row)")
    if not isinstance(previous, dict) or previous.get("schema_version") != SCHEMA_VERSION:
        raise OnlyModeError(f"ONLY_PREVIOUS: the previous catalogue is not schema_version {SCHEMA_VERSION}")

    inputs = load_inputs(registry, marker_groups_tsv, model_warnings_tsv)
    perf = load_performance(registry.scores_csv, {mid})
    facts = load_filter_tables(registry)
    rows = [m for m in previous["methods"] if m["id"] != mid]
    validate_row_filter_facts(rows, facts, "only-mode previous")
    used_required = collections.Counter()
    required_case = {}
    for m in rows:
        for r in (m.get("required_markers") or {}).get("markers") or []:
            key = (str(r.get("id_system") or "other").lower(), str(r.get("id") or "").lower())
            used_required[key] += 1
            required_case.setdefault(key, str(r.get("id") or ""))
    wanted = []
    for key, rid in required_keys(mj):
        used_required[key] += 1
        required_case.setdefault(key, rid)
        wanted.append(key)
    vocab = build_vocabulary(used_required, required_case, inputs["names"], inputs["map_rows"],
                             inputs["group_map"])
    warnings_out = []
    row = sanitize_value(method_row(mid, mj, gate, inputs, perf, warnings_out, facts))

    def mkey(v):
        return (v["system"].lower(), v["id"].lower())

    markers = [dict(v) for v in previous["markers"]]
    have = {mkey(v) for v in markers}
    for v in vocab:
        if mkey(v) in wanted and mkey(v) not in have:
            markers.append(sanitize_value(v))
            have.add(mkey(v))
    markers.sort(key=mkey)
    methods = sorted(rows + [row], key=lambda m: m["id"])
    counts = collections.Counter()
    for m in methods:
        for r in (m.get("required_markers") or {}).get("markers") or []:
            counts[(str(r.get("id_system") or "other").lower(), str(r.get("id") or "").lower())] += 1
    for v in markers:
        v["n_methods"] = counts.get(mkey(v), 0)
    doc = dict(previous)
    doc["methods"] = methods
    doc["markers"] = markers
    # The rebuilt row's disease/treatment facts and the filter_options vocabulary are
    # refreshed from the benchmark tree (schema 2); everything else is carried as it is.
    doc["filter_options"] = sanitize_value(filter_options_for(facts))
    validate_row_filter_facts(doc["methods"], facts, "only-mode output")
    return doc, warnings_out, commit


def dump_to_text(doc):
    hits = hygiene_scan(doc)
    if hits:
        raise ValueError("catalogue hygiene failed:\n  " + "\n  ".join(hits[:20]))
    return json.dumps(doc, indent=1, sort_keys=True) + "\n"


def selftest(fixtures_dir):
    """TEST-MC-15 / TEST-MC-16 invariants against the synthetic fixture registry."""
    import copy
    import shutil
    import tempfile

    registry = Registry(fixtures_dir, is_fixture=True)
    catalogue, selftest_warnings = build_catalogue(registry, SCRIPT_DIR / "marker-groups.tsv",
                                                   SCRIPT_DIR / "model-warnings.tsv")
    checks = []

    def check(name, cond, detail=""):
        checks.append((name, bool(cond), detail))

    def fixture_copy(tmp, tag):
        """A copy of the fixture registry, for the failure-path checks that need a modified
        input (methods.json, categories, parents, treatment tables)."""
        dest = Path(tmp) / f"registry-{tag}"
        shutil.copytree(str(fixtures_dir), str(dest))
        return Registry(dest, is_fixture=True)

    ids = [m["id"] for m in catalogue["methods"]]
    check("methods are exactly the three fixture methods and sorted",
          ids == sorted({"fx-baseline-cox", "fx-asm-methylation-panel", "fx-response-signature"}),
          str(ids))
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

    # ---- schema 2: disease / treatment facts --------------------------------
    expected_disease = {
        "fx-asm-methylation-panel": ("group", ["non-small cell lung cancer"]),
        "fx-baseline-cox": ("any-solid-tumour", []),
        "fx-response-signature": ("group", ["breast cancer"]),
    }
    check("fixture disease facts match defined_for (group, and the any-solid-tumour scope)",
          all(fx[m]["disease"]["scope"] == expected_disease[m][0]
              and fx[m]["disease"]["groups"] == expected_disease[m][1]
              for m in expected_disease),
          str({m: fx[m]["disease"] for m in expected_disease}))
    expected_treatment = {
        "fx-asm-methylation-panel": (["immune checkpoint inhibitor"], "stated"),
        "fx-baseline-cox": ([], "not-stated"),
        "fx-response-signature": (["chemotherapy"], "inferred"),
    }
    check("treatment facts follow the tables (mapped base classes, confidence; "
          "not-stated when the classes are empty or the row is missing)",
          all(fx[m]["treatment"]["classes"] == expected_treatment[m][0]
              and fx[m]["treatment"]["confidence"] == expected_treatment[m][1]
              for m in expected_treatment),
          str({m: fx[m]["treatment"] for m in expected_treatment}))
    check("fx-baseline-cox (missing from method-treatment.tsv) warns and is not-stated",
          any("fx-baseline-cox" in w and "method-treatment" in w for w in selftest_warnings),
          str(selftest_warnings))
    check("every row's disease/treatment holds the loader contract",
          all(m["disease"]["scope"] in DISEASE_SCOPES
              and (m["disease"]["scope"] == "group") == bool(m["disease"]["groups"])
              and m["treatment"]["confidence"] in TREATMENT_CONFIDENCES
              and (m["treatment"]["confidence"] == "not-stated") == (not m["treatment"]["classes"])
              for m in catalogue["methods"]))
    expected_filter_options = {
        "disease_categories": [
            {"id": "Solid tumours", "diseases": [
                {"id": "lung cancer", "children": ["non-small cell lung cancer", "small cell lung cancer"]},
                {"id": "breast cancer", "children": []},
                {"id": "prostate cancer", "children": []},
            ]},
            {"id": "Haematological", "diseases": [
                {"id": "lymphoma", "children": ["diffuse large B-cell lymphoma"]},
            ]},
        ],
        "treatment_classes": [
            {"id": "immune checkpoint inhibitor", "label": "Immune checkpoint inhibitor"},
            {"id": "chemotherapy", "label": "Chemotherapy"},
            {"id": "targeted therapy", "label": "Targeted therapy"},
        ],
    }
    check("filter_options is the fixture tables in table order (categories, diseases, "
          "children, classes; the extra table's row is merged in)",
          catalogue["filter_options"] == expected_filter_options,
          str(catalogue["filter_options"]))
    with open(fixtures_dir / "disease_group_categories.csv", encoding="utf-8", newline="") as f:
        csv_groups = [parts[0].strip() for parts in csv.reader(f)
                      if parts and not parts[0].startswith("#")
                      and parts[0].strip().lower() not in ("disease_group", "disease group")]
    filter_disease_ids = [d["id"] for cat in catalogue["filter_options"]["disease_categories"]
                         for d in cat["diseases"]]
    filter_child_ids = [c for cat in catalogue["filter_options"]["disease_categories"]
                       for d in cat["diseases"] for c in d["children"]]
    check("a child the categories file lists as a group goes under its parent only (not at the "
          "disease level; methods may still name the child)",
          "non-small cell lung cancer" in csv_groups
          and "small cell lung cancer" in csv_groups
          and "diffuse large B-cell lymphoma" in csv_groups
          and set(filter_child_ids) == {"non-small cell lung cancer", "small cell lung cancer",
                                       "diffuse large B-cell lymphoma"}
          and not set(filter_child_ids) & set(filter_disease_ids)
          and fx["fx-asm-methylation-panel"]["disease"]["groups"] == ["non-small cell lung cancer"],
          str((csv_groups, filter_disease_ids, filter_child_ids)))

    with tempfile.TemporaryDirectory(prefix="gen-catalogue-filter-") as tmp:
        facts = load_filter_tables(registry)
        # each disease scope and the mixed defined_for rule (the fixture methods
        # themselves cover `group` and `any-solid-tumour`; `any`, `any-cancer` and the
        # mixed rule are probed here — 0 of the 3 fixture methods mix an `any…` value
        # with a disease name)
        probe = dict(facts)
        probe["methods_json"] = dict(facts["methods_json"])
        scope_cases = [
            ("fx-probe-any", ["any disease"], ("any", [])),
            ("fx-probe-cancer", ["any cancer"], ("any-cancer", [])),
            ("fx-probe-solid", ["any solid tumour"], ("any-solid-tumour", [])),
            ("fx-probe-group", ["non-small cell lung cancer"], ("group", ["non-small cell lung cancer"])),
            ("fx-probe-mixed", ["any cancer", "breast cancer"], ("any-cancer", [])),
        ]
        for mid, defined, _want in scope_cases:
            probe["methods_json"][mid] = defined
        check("each disease scope + a mixed defined_for (broadest any wins, names dropped)",
              all(tuple(disease_for(probe, mid, True, [])[k] for k in ("scope", "groups")) == _want
                  for mid, _defined, _want in scope_cases),
              str({mid: disease_for(probe, mid, True, []) for mid, _d, _w in scope_cases}))
        check("0 of 3 fixture methods mix an `any…` value with a disease name",
              all(not any([d for d in facts["methods_json"][m] if d in _DEFINED_FOR_SCOPES]
                          and [d for d in facts["methods_json"][m] if d not in _DEFINED_FOR_SCOPES])
                  for m in facts["methods_json"]),
              str(facts["methods_json"]))
        # a benchmark class mapping to several base classes (sorted, unique) and the
        # table rows whose confidence is missing/not-stated keep empty classes
        probe2 = dict(facts)
        probe2["treatment"] = dict(facts["treatment"])
        probe2["treatment"]["fx-probe-multi"] = {"class": "systemic therapy", "confidence": "stated"}
        probe2["treatment"]["fx-probe-empty"] = {"class": "chemotherapy", "confidence": "not-stated"}
        ws2 = []
        multi = treatment_for(probe2, "fx-probe-multi", ws2)
        empty = treatment_for(probe2, "fx-probe-empty", ws2)
        check("treatment: a multi-base mapping is sorted+unique; not-stated stays empty",
              multi == {"classes": ["chemotherapy", "targeted therapy"], "confidence": "stated"}
              and empty == {"classes": [], "confidence": "not-stated"},
              str((multi, empty)))
        # a runnable row missing from methods.json is a hard error, naming it
        try:
            reg = fixture_copy(tmp, "missing-row")
            doc = json.loads(reg.methods_json.read_text(encoding="utf-8"))
            doc["methods"] = [m for m in doc["methods"] if m["id"] != "fx-response-signature"]
            reg.methods_json.write_text(json.dumps(doc), encoding="utf-8")
            build_catalogue(reg, SCRIPT_DIR / "marker-groups.tsv", SCRIPT_DIR / "model-warnings.tsv")
            check("a runnable row missing from methods.json is a hard error", False, "no error raised")
        except ValueError as e:
            check("a runnable row missing from methods.json is a hard error",
                  "fx-response-signature" in str(e), str(e))
        # a disease a method uses but that is in neither the CSV nor the extra table
        try:
            reg = fixture_copy(tmp, "unknown-disease")
            doc = json.loads(reg.methods_json.read_text(encoding="utf-8"))
            for m in doc["methods"]:
                if m["id"] == "fx-response-signature":
                    m["biomarkers"]["defined_for"] = ["myeloma"]
            reg.methods_json.write_text(json.dumps(doc), encoding="utf-8")
            build_catalogue(reg, SCRIPT_DIR / "marker-groups.tsv", SCRIPT_DIR / "model-warnings.tsv")
            check("a disease used by a method but in neither category table is a hard error",
                  False, "no error raised")
        except ValueError as e:
            check("a disease used by a method but in neither category table is a hard error",
                  "myeloma" in str(e), str(e))
        # a child the categories file lists under a category different from its parent's
        try:
            reg = fixture_copy(tmp, "child-category-mismatch")
            text = reg.disease_categories_csv.read_text(encoding="utf-8")
            reg.disease_categories_csv.write_text(
                text.replace("non-small cell lung cancer,Solid tumours,",
                             "non-small cell lung cancer,Haematological,"), encoding="utf-8")
            load_filter_tables(reg)
            check("a child whose CSV category differs from its parent's is a hard error "
                  "(child, parent and both categories named)", False, "no error raised")
        except ValueError as e:
            check("a child whose CSV category differs from its parent's is a hard error "
                  "(child, parent and both categories named)",
                  "non-small cell lung cancer" in str(e) and "lung cancer" in str(e)
                  and "Haematological" in str(e) and "Solid tumours" in str(e), str(e))
        # a child whose parent is not a known group (in neither CSV nor extra table)
        try:
            reg = fixture_copy(tmp, "child-unknown-parent")
            text = reg.disease_categories_csv.read_text(encoding="utf-8")
            lines = [ln for ln in text.splitlines() if not ln.startswith("lung cancer,")]
            reg.disease_categories_csv.write_text("\n".join(lines) + "\n", encoding="utf-8")
            load_filter_tables(reg)
            check("a child whose parent is not a known group is a hard error (the parent named)",
                  False, "no error raised")
        except ValueError as e:
            check("a child whose parent is not a known group is a hard error (the parent named)",
                  "lung cancer" in str(e) and "parent_group" in str(e), str(e))
        # a deeper parents chain (a parent that is itself a child)
        chain = Path(tmp) / "chain.tsv"
        chain.write_text("disease_group\tparent_group\tbasis\na\tb\tdraft\nb\tc\tdraft\n",
                         encoding="utf-8")
        try:
            load_disease_parents(chain, {"a", "b", "c"}, {"a": "cat", "b": "cat", "c": "cat"})
            check("a deeper parents chain is a hard error", False, "no error raised")
        except ValueError as e:
            check("a deeper parents chain is a hard error", "one level only" in str(e), str(e))
        # a parents cycle
        cycle = Path(tmp) / "cycle.tsv"
        cycle.write_text("disease_group\tparent_group\tbasis\na\tb\tdraft\nb\ta\tdraft\n",
                         encoding="utf-8")
        try:
            load_disease_parents(cycle, {"a", "b"}, {"a": "cat", "b": "cat"})
            check("a parents cycle is a hard error", False, "no error raised")
        except ValueError as e:
            check("a parents cycle is a hard error", "cycle" in str(e), str(e))
        # an unknown benchmark treatment class
        base = Path(tmp) / "base.tsv"
        base.write_text("id\tlabel\nchemotherapy\tChemotherapy\n", encoding="utf-8")
        classes = Path(tmp) / "classes.tsv"
        classes.write_text("benchmark_class\tbase_classes\nchemotherapy\tchemotherapy\n", encoding="utf-8")
        treat = Path(tmp) / "treat.tsv"
        treat.write_text("method_id\ttreatment_class\tconfidence\tsource_phrase\tsource\n"
                         "fx-x\tno-such-class\tstated\ts\tv\n", encoding="utf-8")
        try:
            load_treatment_facts(treat, classes, base)
            check("an unknown benchmark treatment class is a hard error", False, "no error raised")
        except ValueError as e:
            check("an unknown benchmark treatment class is a hard error",
                  "no-such-class" in str(e), str(e))
        # a base class outside the closed list
        classes2 = Path(tmp) / "classes2.tsv"
        classes2.write_text("benchmark_class\tbase_classes\nchemotherapy\tnot-a-base\n", encoding="utf-8")
        try:
            load_treatment_facts(treat, classes2, base)
            check("a base class outside the closed list is a hard error", False, "no error raised")
        except ValueError as e:
            check("a base class outside the closed list is a hard error",
                  "not-a-base" in str(e), str(e))
        # --filter-facts: a schema-1 previous catalogue comes back as the schema-2 fixture
        # catalogue with every OTHER field (and generated_at + row order) untouched.
        previous = copy.deepcopy(catalogue)
        for m in previous["methods"]:
            m.pop("disease", None)
            m.pop("treatment", None)
        previous.pop("filter_options", None)
        previous["schema_version"] = 1
        upgraded = build_filter_facts(previous, facts, [])
        check("--filter-facts carries every other field byte for byte (schema 1 -> 2)",
              upgraded == catalogue
              and upgraded["generated_from"]["generated_at"]
              == catalogue["generated_from"]["generated_at"]
              and [m["id"] for m in upgraded["methods"]] == [m["id"] for m in catalogue["methods"]]
              and dump_to_text(sanitize_value(upgraded)) == dump_to_text(sanitize_value(catalogue)),
              "" if upgraded == catalogue else "the upgraded catalogue differs from a fresh build")
        # a retired (runnable: false) row missing from methods.json gets scope any + a warning
        warnings_out = []
        retired = disease_for(facts, "fx-not-runnable", False, warnings_out)
        check("a retired row missing from methods.json gets scope any + a warning",
              retired == {"scope": "any", "groups": []}
              and any("fx-not-runnable" in w and "not in methods.json" in w for w in warnings_out),
              str((retired, warnings_out)))

    doc = sanitize_value(catalogue)
    check("sanitized catalogue is free of urls/stud/status tokens",
          hygiene_scan(doc) == [], " ".join(hygiene_scan(doc))[:300])
    check("sanitizer removed the fixture's deliberate 'study' + url from the method text",
          all("study" not in (m.get("description") or "").lower()
              and "example.invalid" not in (m.get("description") or "")
              for m in doc["methods"]),
          str([m["id"] for m in doc["methods"]
               if "study" in (m.get("description") or "").lower()
               or "example.invalid" in (m.get("description") or "")]))
    for name, passed, detail in selftest_only_mode(registry, fixtures_dir, dump_to_text(doc)):
        check(name, passed, detail)
    ok = all(c[1] for c in checks)
    for name, passed, detail in checks:
        print(("PASS" if passed else "FAIL") + f"  {name}" + (f"  [{detail}]" if detail and not passed else ""))
    print(("self-test OK" if ok else "self-test FAILED") + f"  ({len(catalogue['methods'])} fixture methods)")
    return 0 if ok else 1


def selftest_only_mode(registry, fixtures_dir, full_text):
    """The one-method mode against the fixture registry and a throwaway methods repository
    (git): commit A holds the fixture method.json files and gates, commit B (HEAD) bumps
    fx-baseline-cox to 9.9.9. Yields (name, passed, detail)."""
    import copy
    import tempfile

    expected = json.loads(full_text)
    tsv, warn = SCRIPT_DIR / "marker-groups.tsv", SCRIPT_DIR / "model-warnings.tsv"
    with tempfile.TemporaryDirectory(prefix="gen-catalogue-only-") as tmp:
        repo = Path(tmp) / "methods"
        git = ["git", "-C", str(repo), "-c", "user.name=fixture", "-c",
               "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false"]
        repo.mkdir()
        subprocess.run(["git", "init", "-q", str(repo)], check=True, capture_output=True)
        for mid in ("fx-baseline-cox", "fx-asm-methylation-panel"):
            (repo / "methods" / mid).mkdir(parents=True)
            (repo / "methods" / mid / "method.json").write_bytes(
                (fixtures_dir / "methods" / mid / "method.json").read_bytes())
            (repo / "gates").mkdir(exist_ok=True)
            (repo / "gates" / f"{mid}.json").write_bytes((fixtures_dir / "gates" / f"{mid}.json").read_bytes())
        subprocess.run(git + ["add", "-A"], check=True, capture_output=True)
        subprocess.run(git + ["commit", "-q", "-m", "A"], check=True, capture_output=True)
        rev_a = subprocess.run(git + ["rev-parse", "HEAD"], check=True, capture_output=True,
                               text=True).stdout.strip()
        # C: a later commit that leaves the method folders as they are (another arch is often
        # built there, on another machine).
        (repo / "README").write_text("another file\n")
        subprocess.run(git + ["add", "-A"], check=True, capture_output=True)
        subprocess.run(git + ["commit", "-q", "-m", "C"], check=True, capture_output=True)
        rev_c = subprocess.run(git + ["rev-parse", "HEAD"], check=True, capture_output=True,
                               text=True).stdout.strip()
        bumped = json.loads((repo / "methods" / "fx-baseline-cox" / "method.json").read_text())
        bumped["version"] = "9.9.9"
        (repo / "methods" / "fx-baseline-cox" / "method.json").write_text(json.dumps(bumped, indent=1))
        subprocess.run(git + ["commit", "-q", "-am", "B"], check=True, capture_output=True)
        rev_b = subprocess.run(git + ["rev-parse", "HEAD"], check=True, capture_output=True,
                               text=True).stdout.strip()

        def images_at(rev, *mids):
            return {"envs": [{"method_id": m, "source_revision": rev[:12]} for m in mids]}

        def run(mid, previous, images, revision=None):
            try:
                doc, _w, _c = build_only(mid, previous, images, repo, registry, tsv, warn, revision)
                return doc, ""
            except OnlyModeError as e:
                return None, str(e)

        # 1. a stale row is rebuilt; every other row (and the whole file) is carried byte for byte
        previous = copy.deepcopy(expected)
        stale = next(m for m in previous["methods"] if m["id"] == "fx-baseline-cox")
        stale["description"] = "An older description of the fixture method."
        doc, err = run("fx-baseline-cox", previous, images_at(rev_a, "fx-baseline-cox"))
        others_same = doc is not None and all(
            json.dumps(n, indent=1, sort_keys=True) == json.dumps(o, indent=1, sort_keys=True)
            for n, o in zip(doc["methods"], previous["methods"]) if o["id"] != "fx-baseline-cox")
        yield ("only_mode_carries_other_rows_byte_identical",
               doc is not None and others_same and dump_to_text(doc) == full_text,
               err or "the rebuilt file differs from the full generation")

        # 2. method.json is read at the image entry's commit, never at the checkout's HEAD
        doc_a, err_a = run("fx-baseline-cox", previous, images_at(rev_a, "fx-baseline-cox"))
        doc_b, err_b = run("fx-baseline-cox", previous, images_at(rev_b, "fx-baseline-cox"))
        ver = lambda d: d and next(m["version"] for m in d["methods"] if m["id"] == "fx-baseline-cox")
        _none, err_none = run("fx-baseline-cox", previous, {"envs": []})
        _conflict, err_conflict = run("fx-baseline-cox", previous,
                                      images_at(rev_a, "fx-baseline-cox"), revision=rev_b)
        yield ("only_mode_reads_method_json_at_source_revision",
               ver(doc_a) == "1.2.0" and ver(doc_b) == "9.9.9"
               and err_none.startswith("ONLY_NO_IMAGE_ENTRY")
               and err_conflict.startswith("ONLY_REVISION_CONFLICT"),
               f"{ver(doc_a)!r} {ver(doc_b)!r} {err_a or err_b} | {err_none} | {err_conflict}")

        # 4. two arches built at two commits that hold one method tree: the row is read at the
        # newer one; trees that differ need --revision, which must name one of the commits
        def tree_at(rev, mid):
            return subprocess.run(git + ["rev-parse", f"{rev}:methods/{mid}"], check=True,
                                  capture_output=True, text=True).stdout.strip()

        def two_arches(rev1, rev2, mid="fx-baseline-cox"):
            return {"envs": [{"method_id": mid, "arch": "amd64", "source_revision": rev1[:12],
                              "source_tree": tree_at(rev1, mid)},
                             {"method_id": mid, "arch": "arm64", "source_revision": rev2[:12],
                              "source_tree": tree_at(rev2, mid)}]}

        doc_ac, err_ac = run("fx-baseline-cox", previous, two_arches(rev_a, rev_c))
        _ab, err_ab = run("fx-baseline-cox", previous, two_arches(rev_a, rev_b))
        doc_ab_a, err_ab_a = run("fx-baseline-cox", previous, two_arches(rev_a, rev_b), revision=rev_a)
        _ac_b, err_ac_b = run("fx-baseline-cox", previous, two_arches(rev_a, rev_c), revision=rev_b)
        yield ("only_mode_accepts_arches_built_at_two_commits_of_one_tree",
               doc_ac is not None and dump_to_text(doc_ac) == full_text
               and err_ab.startswith("ONLY_REVISION_AMBIGUOUS")
               and ver(doc_ab_a) == "1.2.0"
               and err_ac_b.startswith("ONLY_REVISION_CONFLICT"),
               f"{err_ac} | {err_ab} | {err_ab_a} | {err_ac_b}")

        # 3. adding a row back: its missing vocabulary marker is added, n_methods recounted
        previous = copy.deepcopy(expected)
        previous["methods"] = [m for m in previous["methods"] if m["id"] != "fx-asm-methylation-panel"]
        previous["markers"] = [v for v in previous["markers"] if v["id"] != "GRIA4"]
        for v in previous["markers"]:
            v["n_methods"] = 7
        doc, err = run("fx-asm-methylation-panel", previous, images_at(rev_a, "fx-asm-methylation-panel"))
        counts = doc and {v["id"]: v["n_methods"] for v in doc["markers"]}
        yield ("only_mode_recounts_n_methods",
               doc is not None and dump_to_text(doc) == full_text,
               err or f"n_methods {counts}")


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


def main_only(a):
    """`--only <id> --previous <catalogue> --methods-dir <methods>`: see build_only."""
    if not (a.previous and a.methods_dir):
        print("ONLY_USAGE: --only needs --previous <catalogue> and --methods-dir <methods repository>",
              file=sys.stderr)
        return 2
    if a.check or a.selftest or a.human_names or a.propose_groups or a.filter_facts:
        print("ONLY_USAGE: --only is a separate run", file=sys.stderr)
        return 2
    previous_path = Path(a.previous)
    images_path = Path(a.images) if a.images else previous_path.with_name("method-env-images.json")
    try:
        previous = json.loads(previous_path.read_text(encoding="utf-8"))
        images = json.loads(images_path.read_text(encoding="utf-8")) if images_path.exists() else {}
        registry = Registry(SCRIPT_DIR / "fixtures" if a.fixtures else Path(a.root), is_fixture=a.fixtures)
        doc, warnings_out, commit = build_only(a.only, previous, images, Path(a.methods_dir), registry,
                                               SCRIPT_DIR / "marker-groups.tsv",
                                               SCRIPT_DIR / "model-warnings.tsv", a.revision)
    except (OnlyModeError, OSError, ValueError) as e:
        print(f"gen_method_catalogue --only {a.only}: {e}", file=sys.stderr)
        return 1
    for w in warnings_out:
        print(f"warning: {w}")
    out = Path(a.out) if a.out else previous_path
    out.write_text(dump_to_text(doc), encoding="utf-8")
    row = next(m for m in doc["methods"] if m["id"] == a.only)
    print(f"wrote {out}: row {a.only} {row['version']} rebuilt at {commit[:12]}, "
          f"{len(doc['methods'])} methods, {len(doc['markers'])} markers")
    return 0


def main_filter_facts(a):
    """`--filter-facts --previous <catalogue>`: see build_filter_facts (the shipped-catalogue
    schema-2 upgrade; --fixtures reads the fixture tables for the hermetic selftest)."""
    if not a.previous:
        print("FILTER_USAGE: --filter-facts needs --previous <catalogue>", file=sys.stderr)
        return 2
    if a.check or a.selftest or a.human_names or a.propose_groups or a.only:
        print("FILTER_USAGE: --filter-facts is a separate run", file=sys.stderr)
        return 2
    previous_path = Path(a.previous)
    try:
        previous = json.loads(previous_path.read_text(encoding="utf-8"))
        registry = Registry(SCRIPT_DIR / "fixtures" if a.fixtures else Path(a.root), is_fixture=a.fixtures)
        facts = load_filter_tables(registry)
        warnings_out = []
        doc = build_filter_facts(previous, facts, warnings_out)
        validate_row_filter_facts(doc["methods"], facts, "filter-facts output")
    except (OSError, ValueError) as e:
        print(f"gen_method_catalogue --filter-facts: {e}", file=sys.stderr)
        return 1
    for w in warnings_out:
        print(f"warning: {w}")
    out = Path(a.out) if a.out else previous_path
    out.write_text(dump_to_text(doc), encoding="utf-8")
    print(f"wrote {out}: {len(doc['methods'])} methods, {len(doc['markers'])} markers, "
          f"{len(doc['filter_options']['disease_categories'])} disease categories, "
          f"{len(doc['filter_options']['treatment_classes'])} treatment classes "
          f"(schema_version {doc['schema_version']})")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Generate the TxResBench method catalogue (data/method-catalogue/catalogue.json)")
    ap.add_argument("--out", default=None,
                    help="the file to write (default data/method-catalogue/catalogue.json; with "
                         "--only or --filter-facts, the --previous file)")
    ap.add_argument("--fixtures", action="store_true", help="use the synthetic fixture registry")
    ap.add_argument("--check", action="store_true", help="generate and byte-compare with the target file")
    ap.add_argument("--selftest", action="store_true", help="run the generator invariants (TEST-MC-15/16)")
    ap.add_argument("--propose-groups", action="store_true", help="write a marker-groups proposal tsv")
    ap.add_argument("--human-names", action="store_true",
                    help="backfill the title/summary/paper_title fields of the committed catalogue "
                         "without a full regeneration (the live-tree regen is the owner's runbook step)")
    ap.add_argument("--root", default=os.environ.get("SIGTRANS_ROOT", str(DEFAULT_SIGTRANS_ROOT)),
                    help="benchmark tree root (default SIGTRANS_ROOT or /data/share/pbya/sigtrans)")
    ap.add_argument("--only", metavar="ID",
                    help="one-method mode: rebuild (or add) this method's row of --previous, carry "
                         "every other row byte for byte, add the vocabulary markers it needs, "
                         "recount n_methods and refresh the row's disease/treatment facts and the "
                         "filter_options block; method.json and the gate are read from --methods-dir "
                         "at the method's image entries' source_revision")
    ap.add_argument("--filter-facts", action="store_true",
                    help="schema-2 upgrade mode: rewrite ONLY every row's disease/treatment facts "
                         "and the filter_options block of --previous, set schema_version 2, and "
                         "carry everything else (row order, generated_at) byte for byte")
    ap.add_argument("--previous", metavar="FILE",
                    help="with --only or --filter-facts: the catalogue to change (the methods "
                         "repository's method-list/catalogue.json, or the shipped catalogue being "
                         "upgraded)")
    ap.add_argument("--methods-dir", metavar="DIR", default=os.environ.get("TXR_METHODS_DIR"),
                    help="with --only: the methods repository (git)")
    ap.add_argument("--images", metavar="FILE",
                    help="with --only: the env images list whose entries name the commit "
                         "(default: method-env-images.json next to --previous)")
    ap.add_argument("--revision", metavar="COMMIT",
                    help="with --only: the methods commit to read (a method without an image entry)")
    a = ap.parse_args(argv)

    if a.only:
        return main_only(a)
    if a.filter_facts:
        return main_filter_facts(a)
    if a.previous or a.images or a.revision:
        ap.error("--previous, --images and --revision go with --only or --filter-facts")
    a.out = a.out or str(DEFAULT_CATALOGUE)

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
