#!/usr/bin/env python3
"""Write the minimal VALID demo bundle the demo-mode browser tier boots with.

A version-1 bundle (the loader's own format) whose recorded example hashes
are the REAL embedded example files' (computed with the recorder's canonical
hash — the Python twin of the Rust `modules/demo/bundle.rs`, pinned by
`record_demo_bundle.test.py`), one recorded configuration (pfs / day 56 /
look ahead 238 / no covariates — the example setup, the FIRST recorded one
of a real recording) and one recorded method (kelim, 150 recorded seconds —
15 s of replay at the default speed 10, long enough for the running page's
live state to be observed). The prediction tables carry the example files'
own patient ids, so the results surface reads real rows.

The bundle is TEST DATA for `playwright.demo.config.ts`'s webServer: never
committed, written outside the repo (the config passes its own scratch dir).
"""
import argparse
import csv
import importlib.util
import json
import os
import sys

# The recorder module's canonical hash (the cross-language lockstep with the
# server loader) is the one source — never a duplicate implementation. The
# recorder's file name carries a hyphen (the git name), so it is loaded by
# path (the same way its own test file loads it).
_RECORDER_PATH = os.path.join(
    os.path.dirname(os.path.realpath(__file__)), "record-demo-bundle.py"
)
_RECORDER_SPEC = importlib.util.spec_from_file_location("record_demo_bundle", _RECORDER_PATH)
record_demo_bundle = importlib.util.module_from_spec(_RECORDER_SPEC)
_RECORDER_SPEC.loader.exec_module(record_demo_bundle)
canonical_content_hash = record_demo_bundle.canonical_content_hash
table_from_csv_text = record_demo_bundle.table_from_csv_text

FORMAT_TAG = "txresbench-demo-bundle"
FORMAT_VERSION = 1
DATASET_ID = "example"

# The recorded method: the loaded bundle offers ONLY recorded methods, and
# kelim is the example family's fast kinetics method.
METHOD_ID = "kelim"
RECORDED_SECONDS = 150.0
CONFIG_ID = "pfs_d56_h238"
CONFIG = {
    "id": CONFIG_ID,
    "endpoint": "pfs",
    "decision_day": 56.0,
    "look_ahead_day": 238.0,
    "covariates": False,
    "logs": [{"method_id": METHOD_ID, "stream": "engine", "content": "started"}],
}


def read_table(path):
    """The (columns, rows) pair of a CSV asset (the recorder's table shape)."""
    with open(path, "r", encoding="utf-8", newline="") as fh:
        text = fh.read()
    table = table_from_csv_text(text, os.path.basename(path))
    return table["columns"], table["rows"]


def facts(columns, rows):
    return {
        "content_hash": canonical_content_hash(columns, rows),
        "rows": len(rows),
        "columns": columns,
    }


def write_prediction_table(path, patient_ids):
    """The chance-shaped table (patient_id,probability,note), the engine
    codec's own row shape."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh, lineterminator="\n")
        writer.writerow(["patient_id", "probability", "note"])
        for pid in patient_ids:
            writer.writerow([pid, 0.62, ""])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets", required=True, help="the data/file-validator/examples dir")
    parser.add_argument("--out", required=True, help="the bundle dir to write")
    args = parser.parse_args(argv)

    train_patients = [row[0] for row in read_table(os.path.join(args.assets, "patients.csv"))[1]]
    predict_patients = [
        row[0] for row in read_table(os.path.join(args.assets, "predict-measurements.csv"))[1]
    ]

    write_prediction_table(
        os.path.join(args.out, "train", CONFIG_ID, f"{METHOD_ID}.csv"),
        train_patients,
    )
    write_prediction_table(
        os.path.join(args.out, "reuse", CONFIG_ID, f"{METHOD_ID}.csv"),
        predict_patients,
    )

    manifest = {
        "format": FORMAT_TAG,
        "version": FORMAT_VERSION,
        "generated_at": "2026-11-14T00:00:00Z",
        "dataset_id": DATASET_ID,
        "tables": {
            "patients": facts(*read_table(os.path.join(args.assets, "patients.csv"))),
            "measurements": facts(*read_table(os.path.join(args.assets, "measurements.csv"))),
            "predict_measurements": facts(
                *read_table(os.path.join(args.assets, "predict-measurements.csv"))
            ),
        },
        "configurations": [CONFIG],
        "methods": [
            {
                "method_id": METHOD_ID,
                "records": [
                    {
                        "configuration_id": CONFIG_ID,
                        "seconds": RECORDED_SECONDS,
                        "train": {
                            "table": f"train/{CONFIG_ID}/{METHOD_ID}.csv",
                            "label": METHOD_ID,
                            "group": "kinetics",
                            "group_label": "Kinetics",
                            "task": "pfs",
                            "prob_source": "native",
                            "flat_conversion": False,
                            "coverage": {
                                "scored": len(train_patients),
                                "eligible": len(train_patients),
                                "fraction": 1.0,
                            },
                            "rows": len(train_patients),
                        },
                        "model": {
                            "name": METHOD_ID,
                            "method_version": "1.0.0",
                            "group": "kinetics",
                            "group_label": "Kinetics",
                            "task": "pfs",
                            "trained_on_patients": len(train_patients),
                            "trained_at": "2026-11-14T00:00:00Z",
                            "decision_day": 56.0,
                            "endpoint": "pfs",
                            "horizon": 238.0,
                            "size_bytes": 1024,
                            "embeds_training_data": False,
                            "own_auc": 0.71,
                            "marker_count": 3,
                            "marker_kind": "all",
                            "uses_covariates": False,
                        },
                        "reuse": {
                            "table": f"reuse/{CONFIG_ID}/{METHOD_ID}.csv",
                            "label": METHOD_ID,
                            "group": "kinetics",
                            "group_label": "Kinetics",
                            "task": "pfs",
                            "prob_source": "native",
                            "flat_conversion": False,
                            "coverage": {
                                "scored": len(predict_patients),
                                "eligible": len(predict_patients),
                                "fraction": 1.0,
                            },
                            "rows": len(predict_patients),
                        },
                    }
                ],
            }
        ],
    }
    with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")
    print(
        f"wrote the demo test bundle to {args.out} "
        f"({len(train_patients)} train / {len(predict_patients)} predict patients)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
