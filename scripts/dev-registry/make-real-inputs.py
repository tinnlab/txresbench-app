#!/usr/bin/env python3
"""make-real-inputs — ITEM-3 (node qa-hardening): convert ONE OPEN benchmark
dataset's tidy tables into the app's two-file input contract.

WHAT IT DOES
------------
Reads the benchmark tidy 2.0 tables of one dataset from
`/data/share/pbya/sigtrans/dev/data/benchmark/<dataset>/tidy/` (read-only) and
writes, under a directory under `/data/pbya/txresbench-app-work/qa-data/`
(outside the repo — DEC-1, nothing of this is committed):

  * `patients.csv`       — the C-screen patients table: the four board outcome
    columns (`patient_id, pfs_days, pfs_event, os_days, os_event`) plus the
    optional response pair (`responder`, `response_day`), per the board column
    spec embedded by `file_validator` (`data/file-validator/templates/*.csv`,
    D48, R02);
  * `measurements.csv`   — the C-screen measurements table
    (`patient_id, day, marker, value, unit`), one row per draw x marker;
  * `predict-measurements.csv` — the N-screen measurements-only table (the
    SAME column set; the shape the saved-model reuse path reads — the
    "prediction-only measurements file" of the plan);
  * `inputs.json`        — the wire facts the e2e driver posts (the marker
    columns, the resolved marker mapping, the unit spellings, the cohort
    facts, the recommended run settings).

WHAT IS DELIBERATE (each a recorded choice, in `inputs.json` + the report):
- **One dataset, one marker family.** The app's two-file contract and the
  engine's per-method marker-count rule (`method_marker_set`: a `single`
  method with no fixed list takes THE FILE's main markers) make a
  multi-marker upload refuse every single-marker method, so the converter
  reduces the dataset's per-sample features to its curated primary markers
  (`dataset.yaml curated_markers`, the dataset-gate's own rank): INSPIRE's
  `ctDNA_mean_MTM_per_ml` (the paper's absolute ctDNA level) and its
  `__detected` companion. The deposit's variant-level features (1501
  per-target rows) and the QC/alternate-scale features are NOT converted —
  they belong to a later stage of the app's multi-marker contract.
- **Days.** The tidy `day_from_start` is already days from treatment start
  (day 0 = first dose), which is the app's own origin (`baseline_max_day`
  pins 0); the patients-table survival times follow the tidy's OWN
  `time_unit` declaration (qa-fixes ITEM-6, F8): values declared `day` pass
  through, values declared `month` convert with the benchmark's factor
  (30.4375), and an unrecognized unit refuses loudly — the old converter
  multiplied ALREADY-DAY values by 30.4375 and shipped follow-ups of up to
  32,812 days (90 years). The app admits days only (`pfs_days`); no
  `time_unit` column is written (R12's default days). Every converted value
  is range-checked against [`MAX_PLAUSIBLE_DAYS`].
- **The response pair is both-or-neither** (R18): a patient whose tidy row has
  a label but no assessment day is written with BOTH cells empty (the
  label-without-day shape is not in the app's outcome-pair contract; the
  honest omission is recorded in `inputs.json`).
- **The predict file is the full measurements table** — the strongest reuse
  check: the reuse run's per-patient predictions must equal the train run's.
- **No data is ever written into the repo**, and the tidy sources are read
  only (the data directory is owner-only and untouched).

RUN
---
    python3 scripts/dev-registry/make-real-inputs.py            # defaults
    python3 scripts/dev-registry/make-real-inputs.py --out DIR  # custom

Requires the host python3 with pandas + pyarrow (the parquet readers); the
produced files are plain CSV/JSON, so the e2e driver needs only stdlib.
"""

import argparse
import csv
import json
import os
import sys

#: The benchmark data root (read-only).
BENCHMARK_ROOT = "/data/share/pbya/sigtrans/dev/data/benchmark"
#: The default output root (outside the repo, DEC-1).
DEFAULT_OUT = "/data/pbya/txresbench-app-work/qa-data"
#: Month -> day factor (the benchmark's own day decoding, 365.25/12).
DAY_PER_MONTH = 30.4375
#: The longest plausible survival (20 years in days) — a converted follow-up
#: beyond this means the unit was misread (qa-fixes ITEM-6, F8: the old
#: converter multiplied ALREADY-DAY values by 30.4375 and shipped follow-ups
#: of up to 32,812 days).
MAX_PLAUSIBLE_DAYS = 7300
#: The converter's default dataset (open, tidy-validated, serial ctDNA +
#: response + PFS/OS in one cohort — the shape ITEM-3's run needs).
DEFAULT_DATASET = "Bratman2020_INSPIRE-ctDNA"


def survival_unit_of(unit_text):
    """The tidy time_unit spelling -> the conversion rule (qa-fixes ITEM-6, F8).

    The tidy patients table declares the unit of EVERY survival value in its
    own `time_unit` column; the converter respects that declaration instead of
    assuming months. `'month'` is converted (x DAY_PER_MONTH), `'day'` /
    `'days'` passes through, anything else refuses loudly - a mixed/unread
    unit would silently ship implausible follow-ups (the F8 defect: values
    already in days multiplied by 30.4375, max 32,812 days = 90 years).
    """
    norm = str(unit_text).strip().lower()
    if norm in ("day", "days"):
        return "day"
    if norm in ("month", "months"):
        return "month"
    raise RuntimeError(f"unrecognized survival time_unit {unit_text!r}")


def convert_survival_time(value, unit):
    """One survival time to app days: months x DAY_PER_MONTH, days verbatim."""
    f = float(value)
    if survival_unit_of(unit) == "month":
        f = f * DAY_PER_MONTH
    days = int(round(f))
    if days < 0 or days > MAX_PLAUSIBLE_DAYS:
        raise RuntimeError(
            f"survival time {value} {unit} converts to {days} days "
            f"(> {MAX_PLAUSIBLE_DAYS}); the unit is likely misread"
        )
    return days


def fmt_value(v):
    """A CSV-safe numeric cell: ints as ints, floats shortest-round-trip-ish."""
    if v is None or v == "":
        return ""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return ""
    if f != f:  # NaN — a missing cell, not a literal
        return ""
    if f in (float("inf"), float("-inf")):
        return str(f)
    if f == int(f) and abs(f) < 1e15:
        return str(int(f))
    return ("%.10g" % f)


def fmt_day(v):
    """A draw day: the tidy days are exact integers (verified by the dataset
    build); write them as integers."""
    f = float(v)
    if abs(f - round(f)) < 1e-6:
        return str(int(round(f)))
    return ("%.6g" % f)


def load_tidy(dataset):
    import pandas

    tidy = os.path.join(BENCHMARK_ROOT, dataset, "tidy")
    patients = pandas.read_parquet(os.path.join(tidy, "patients.parquet"))
    values = pandas.read_parquet(os.path.join(tidy, "values.parquet"))
    features = pandas.read_parquet(os.path.join(tidy, "features.parquet"))
    meta = json.load(open(os.path.join(tidy, "values.meta.json")))
    return patients, values, features, meta


def primary_markers(dataset, features):
    """The curated primary feature names: dataset.yaml `curated_markers`
    (ranked) mapped to the deposited features — for INSPIRE the curated
    `ctDNA_MTM` -> feature `ctDNA_mean_MTM_per_ml`. When the dataset carries
    no curated list, the first measurable (non-companion, non-LOD) feature in
    deposit order is used."""
    curated = {"Bratman2020_INSPIRE-ctDNA": ["ctDNA_mean_MTM_per_ml"]}
    if dataset in curated:
        return curated[dataset]
    mains = [
        r.feature
        for r in features.itertuples(index=False)
        if not str(r.feature).endswith("__detected")
        and not str(r.feature).endswith("__lod")
    ]
    if not mains:
        raise RuntimeError(f"dataset {dataset}: no measurable feature found")
    return [mains[0]]


def build_tables(dataset, out, markers):
    patients, values, features, meta = load_tidy(dataset)
    unit_of = dict(zip(features["feature"], features["unit"]))
    rows = []

    # The app's only allowed id type: non-empty strings in file order.
    for r in patients.itertuples(index=False):
        pid = str(r.patient_id)
        if not pid:
            continue
        unit_text = getattr(r, "time_unit", None)
        if unit_text is None or str(unit_text).strip() == "":
            raise RuntimeError(f"patient {pid}: the tidy patients table carries no time_unit")
        unit = survival_unit_of(unit_text)
        pfs_days = ""
        pfs_ev = ""
        os_days = ""
        os_ev = ""
        responder = ""
        resp_day = ""
        t = getattr(r, "pfs_time", None)
        e = getattr(r, "pfs_event", None)
        try:
            if t is not None and t == t and e is not None:
                pfs_days = str(convert_survival_time(t, unit))
                pfs_ev = str(int(float(e)))
        except RuntimeError as ex:
            raise RuntimeError(f"patient {pid} pfs: {ex}") from ex
        except (TypeError, ValueError):
            pass
        try:
            to = getattr(r, "os_time", None)
            eo = getattr(r, "os_event", None)
            if to is not None and to == to and eo is not None:
                os_days = str(convert_survival_time(to, unit))
                os_ev = str(int(float(eo)))
        except RuntimeError as ex:
            raise RuntimeError(f"patient {pid} os: {ex}") from ex
        except (TypeError, ValueError):
            pass
        rb = getattr(r, "responder_binary", None)
        rd = getattr(r, "response_assessment_day", None)
        try:
            rb_ok = rb is not None and rb == rb
            rd_ok = rd is not None and rd == rd
            if rb_ok and rd_ok:
                responder = str(int(float(rb)))
                resp_day = str(int(round(float(rd))))
        except (TypeError, ValueError):
            pass
        rows.append([pid, pfs_days, pfs_ev, os_days, os_ev, responder, resp_day])

    value_rows = []
    dropped = 0
    seen = set()
    for r in values.itertuples(index=False):
        feature = str(r.feature)
        if feature not in markers:
            continue
        pid = str(r.patient_id)
        day = fmt_day(r.day_from_start)
        value = fmt_value(r.value)
        unit = str(unit_of.get(feature, ""))
        # The app's uniqueness key is (patient_id, day, marker) — one sample
        # per draw (R07). The tidy key is (patient_id, sample_id, feature),
        # so a day holding TWO samples (the deposit's INS-D-001 day-419 pair)
        # would be a duplicate of the app's key; the first sample in deposit
        # order is kept, the second is dropped (counted below, recorded in
        # inputs.json).
        k = (pid, day, feature)
        if k in seen:
            dropped += 1
            continue
        seen.add(k)
        value_rows.append([pid, day, feature, value, unit])

    return rows, value_rows, dropped


def write_csv(path, columns, rows):
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(columns)
        w.writerows(rows)


def main(argv=None):
    ap = argparse.ArgumentParser(description="TxResBench ITEM-3 input converter (open benchmark tidy -> app two-file contract)")
    ap.add_argument("--dataset", default=DEFAULT_DATASET)
    ap.add_argument("--out", default=DEFAULT_OUT)
    args = ap.parse_args(argv)

    dataset = args.dataset
    if dataset.startswith("AACR-") or "GENIE" in dataset:
        raise SystemExit(f"refusing dataset {dataset}: controlled (DEC-1)")
    if not os.path.isdir(os.path.join(BENCHMARK_ROOT, dataset, "tidy")):
        raise SystemExit(f"no tidy tables for {dataset} under {BENCHMARK_ROOT}")

    _patients, values, features, meta = load_tidy(dataset)
    markers = primary_markers(dataset, features)
    # Companions follow their base marker (the R13 contract + the engine's
    # companion rule): a curated marker's `__detected` sibling rides along.
    for m in list(markers):
        comp = m + "__detected"
        if comp in set(features["feature"]):
            markers.append(comp)
    for m in markers:
        if m not in set(features["feature"]):
            raise SystemExit(f"marker {m} is not a feature of {dataset}")

    out_dir = os.path.join(args.out, dataset + "-app")
    os.makedirs(out_dir, exist_ok=True)
    patients_path = os.path.join(out_dir, "patients.csv")
    measurements_path = os.path.join(out_dir, "measurements.csv")
    predict_path = os.path.join(out_dir, "predict-measurements.csv")

    patient_rows, value_rows, dropped = build_tables(dataset, out_dir, markers)
    write_csv(patients_path, ["patient_id", "pfs_days", "pfs_event", "os_days", "os_event", "responder", "response_day"], patient_rows)
    write_csv(measurements_path, ["patient_id", "day", "marker", "value", "unit"], value_rows)
    write_csv(predict_path, ["patient_id", "day", "marker", "value", "unit"], value_rows)

    with_response = sum(1 for r in patient_rows if r[5] and r[6])
    pfs_days = [int(r[1]) for r in patient_rows if r[1]]
    os_days = [int(r[3]) for r in patient_rows if r[3]]
    events = sum(1 for r in patient_rows if r[2] == "1")
    conversion_facts = {
        "dataset": dataset,
        "source": os.path.join(BENCHMARK_ROOT, dataset, "tidy"),
        "access": "open",
        "converted_at": "item-6-f8",
        "markers": markers,
        "marker_mapping": [
            {"key": m, "marker_id": mapping_id(m)} for m in markers if not m.endswith("__detected")
        ],
        "units": {m: str(unit_of(m, features)) for m in markers},
        "n_patients": len(patient_rows),
        "n_values": len(value_rows),
        "n_duplicate_draw_rows_dropped": dropped,
        "n_patients_with_response_pair": with_response,
        "n_primary_events": events,
        "survival_time_unit": "day (tidy time_unit declaration)",
        "pfs_days_range": [min(pfs_days), max(pfs_days)] if pfs_days else None,
        "os_days_range": [min(os_days), max(os_days)] if os_days else None,
        "notes": [
            "survival times follow the tidy time_unit declaration: day values pass through, month values convert (x 30.4375); each converted value is range-checked (<= 7300 days) - the old converter multiplied already-days values (max 32,812 days = 90 years)",
            "the deposit's variant-level and alternate-scale ctDNA features are not converted (single-marker app contract)",
            "patients with a response label but no assessment day carry BOTH cells empty (R18 both-or-neither)",
            "one draw day holding two samples (INS-D-001 day 419) is reduced to the first sample (the app's key is patient/day/marker; see n_duplicate_draw_rows_dropped)",
            "predict-measurements.csv is the full measurements table (the reuse check compares per-patient predictions)",
        ],
    }
    with open(os.path.join(out_dir, "inputs.json"), "w") as fh:
        json.dump(conversion_facts, fh, indent=2, sort_keys=True)

    print(f"dataset {dataset}: {len(patient_rows)} patients, {len(value_rows)} measurement rows")
    print(f"markers: {', '.join(markers)}")
    print(f"survival unit: {conversion_facts['survival_time_unit']}; "
          f"pfs range {conversion_facts['pfs_days_range']}, "
          f"os range {conversion_facts['os_days_range']}, events {events}")
    print(f"wrote {out_dir}/ {{patients.csv, measurements.csv, predict-measurements.csv, inputs.json}}")
    return 0


def unit_of(marker, features):
    m = features[features["feature"] == marker]
    if len(m):
        return str(m.iloc[0]["unit"])
    return ""


def mapping_id(marker):
    """The app's vocabulary marker id for the converter's default dataset:
    the curated id of the deposited feature (dataset.yaml curated_markers).
    For a feature without a curated id the vocabulary alias search would be
    needed; the converter's default set is the curated one."""
    curated = {
        "ctDNA_mean_MTM_per_ml": "ctDNA_MTM",
    }
    return curated.get(marker, marker)


if __name__ == "__main__":
    sys.exit(main())
