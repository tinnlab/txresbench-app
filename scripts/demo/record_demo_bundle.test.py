#!/usr/bin/env python3
"""Tests for scripts/demo/record-demo-bundle.py (demo-mode ITEM-2).

The recorder drives a RUNNING desktop-mode app over HTTP; these unit tests
run its step logic against a scripted in-process transport (the module's
`_http` seam — the import of the driver replaces that one attribute, nothing
else). They pin: the canonical content hash's cross-language lockstep with
`modules/demo/bundle.rs` (the SAME vector, so a drift between the Python and
Rust encoders fails one side loudly), the recorded-configuration id grammar,
the bundle writer's manifest shape, and the whole recording flow's step order
against a fake app (including the honest SKIP of an optional configuration
the fake cannot record).

Unittest, stdlib only, no network, no data of any kind. The report/bundle
files each run writes go under /data/pbya/txresbench-app-work/ (never /tmp —
the repo's working-file rule) and are removed by the run.

Run: python3 scripts/demo/record_demo_bundle.test.py
"""

import importlib.util
import json
import os
import shutil
import sys
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
_spec = importlib.util.spec_from_file_location(
    "record_demo_bundle_under_test", os.path.join(_HERE, "record-demo-bundle.py")
)
under_test = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(under_test)

#: The work-record root (the repo's working-file rule: never /tmp).
WORK_DIR = "/data/pbya/txresbench-app-work/qa-data"


def example_csv(kind):
    """A tiny example-family CSV (the flow's pins: 100 training patients,
    15 predict patients, markers M1/M2/M3)."""
    if kind == "patients":
        rows = [f"J{i:04d},{200+i},1,{400+i},1,0,{30+i % 20},{50+i % 20},M,II"
                for i in range(100)]
    elif kind == "predict-measurements":
        rows = [f"J1{i:03d},0,M{1+(i % 3)},{1.0+i/10.0},a.u."
                for i in range(15) for _ in range(3)]
        # Keep the marker column exactly M1/M2/M3 (the above formula covers it).
        rows = [f"J1{i // 3:03d},0,M{1 + (i % 3)},{1.0 + i / 10.0},a.u."
                for i in range(45)]
    else:  # measurements (training)
        rows = [f"J{i // 3:04d},0,M{1 + (i % 3)},{1.0 + i / 10.0},a.u."
                for i in range(300)]
    header = ("patient_id,day,marker,value,unit" if kind != "patients"
              else "patient_id,pfs_days,pfs_event,os_days,os_event,responder,response_day,age,sex,stage")
    return (header + "\n" + "\n".join(rows) + "\n").encode("utf-8")


class FakeApp:
    """The scripted transport: answers the whole recording flow without a
    server. Two train runs — the first finishes (the required configuration),
    the second (the optional one) fails — so the flow's honest SKIP branch is
    exercised too."""

    def __init__(self):
        self.calls = []
        self.train_runs = 0

    def predictions(self):
        patients = [f"J{i:04d}" for i in range(94)]
        return {
            "run_id": "run-1",
            "endpoint": "pfs",
            "horizon": 238.0,
            "patients": patients,
            "methods": [{
                "method_id": "kelim",
                "label": "kelim",
                "group": "kinetics",
                "group_label": "Kinetics",
                "task": "pfs",
                "prob_source": "native",
                "flat_conversion": False,
                "coverage": {"scored": 94, "eligible": 94, "fraction": 1.0},
                "probabilities": [0.5] * 94,
                "notes": [None] * 94,
            }],
            "average": [0.5] * 94,
            "generated_at": "2026-11-14T00:00:00Z",
        }

    def reuse_predictions(self):
        return {
            "run_id": "reuse-1",
            "patients": [f"J{i:04d}" for i in range(15)],
            "methods": [{
                "method_id": "model-1",
                "label": "kelim",
                "group": "kinetics",
                "group_label": "Kinetics",
                "task": "pfs",
                "prob_source": "native",
                "flat_conversion": False,
                "coverage": {"scored": 15, "eligible": 15, "fraction": 1.0},
                "probabilities": [0.5] * 15,
                "notes": [None] * 15,
            }],
        }

    def handle(self, method, path, body=None, token=None):
        self.calls.append((method, path))
        if path == "/app/mode" and method == "GET":
            return 200, {"mode": "desktop"}
        if path == "/session/local" and method == "POST":
            return 200, {"access_token": "tok"}
        if path.startswith("/file-validation/examples/") and method == "GET":
            kind = path.rsplit("/", 1)[1]
            return 200, example_csv(kind)
        if path == "/file-validation/inspect" and method == "POST":
            rows = body["table"].get("rows", [])
            return 200, {"problems": [], "summary": {"rows": len(rows)}}
        if path == "/file-validation/validate" and method == "POST":
            return 200, {
                "markers": [{"key": "M1"}, {"key": "M2"}, {"key": "M3"}],
                "inventory": {"patients": 100},
                "problems": [],
            }
        if path == "/methods/eligibility" and method == "POST":
            return 200, {"methods": [{"id": "kelim", "status": "can_run"}], "total_fit": 1}
        if path == "/txr/runs" and method == "POST":
            self.train_runs += 1
            if body.get("mode") == "reuse":
                return 202, {"id": "reuse-1", "status": "preparing"}
            run_id = "run-1" if self.train_runs == 1 else f"run-{self.train_runs}"
            return 202, {"id": run_id, "status": "preparing"}
        if path.startswith("/txr/runs/") and method == "GET" and path.endswith("/predictions"):
            if "reuse-1" in path:
                return 200, self.reuse_predictions()
            return 200, self.predictions()
        if path.startswith("/txr/runs/") and method == "GET":
            run_id = path.split("/")[3]
            if run_id == "reuse-1":
                return 200, {"id": run_id, "status": "finished", "methods": []}
            if run_id == "run-1":
                return 200, {
                    "id": run_id,
                    "status": "finished",
                    "methods": [{"method_id": "kelim", "state": "finished",
                                 "elapsed_secs": 12}],
                }
            return 200, {"id": run_id, "status": "failed",
                         "methods": [{"method_id": "kelim", "state": "failed"}]}
        if path.endswith("/logs") and method == "GET":
            return 200, {
                "lines": [{"seq": 1, "method_id": "kelim", "stream": "engine",
                           "content": "started", "created_at": "2026-11-14T00:00:00Z"}],
                "next_seq": 1,
                "total": 1,
            }
        if path == "/txr/models/save" and method == "POST":
            return 200, {
                "set": {"id": "set-1", "name": "Recorded demo bundle pfs_d56_h238"},
                "models": [{
                    "id": "model-1",
                    "method_id": "kelim",
                    "name": "kelim",
                    "method_version": "1.0.0",
                    "group": "kinetics",
                    "group_label": "Kinetics",
                    "task": "pfs",
                    "trained_on_patients": 94,
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
                }],
            }
        if path == "/txr/models/resolve" and method == "POST":
            return 200, {"assets": [{"model_id": "model-1", "host_dir": "/x",
                                     "tree_sha256": "a" * 64, "method_id": "kelim",
                                     "method_version": "1.0.0", "contract": "v1"}]}
        raise AssertionError(f"unexpected call: {method} {path}")


class CanonicalHashTests(unittest.TestCase):
    def test_the_pinned_vector_matches_the_rust_side(self):
        # THE cross-language lockstep: identical table + expected text + hash
        # to `modules/demo/bundle.rs`'s canonical_hash_matches_the_recorder_vector.
        columns = ["a", "b"]
        rows = [["x", "y"], ["1", None], ["2", "3"],
                ["with,comma", 'say "hi"']]
        text = under_test.canonical_table_text(columns, rows)
        self.assertEqual(
            text,
            "a,b\nx,y\n1\n2,3\n\"with,comma\",\"say \"\"hi\"\"\"",
        )
        self.assertEqual(
            under_test.canonical_content_hash(columns, rows),
            "sha256:" + __import__("hashlib").sha256(text.encode("utf-8")).hexdigest(),
        )

    def test_trailing_empty_cells_do_not_change_the_hash(self):
        c = ["a", "b", "c"]
        self.assertEqual(
            under_test.canonical_content_hash(c, [["1", "2", None]]),
            under_test.canonical_content_hash(c, [["1", "2"]]),
        )
        self.assertNotEqual(
            under_test.canonical_content_hash(c, [["1", "2", None]]),
            under_test.canonical_content_hash(c, [["1", None, "3"]]),
        )


class ConfigIdTests(unittest.TestCase):
    def test_the_recorded_configuration_id_grammar(self):
        cid = under_test.config_id
        self.assertEqual(
            cid({"endpoint": "pfs", "decision_day": 56.0, "look_ahead_day": 238.0,
                 "covariates": False}),
            "pfs_d56_h238",
        )
        self.assertEqual(
            cid({"endpoint": "os", "decision_day": 56.0, "look_ahead_day": 238.0,
                 "covariates": False}),
            "os_d56_h238",
        )
        self.assertEqual(
            cid({"endpoint": "pfs", "decision_day": 56.5, "look_ahead_day": 238.0,
                 "covariates": True}),
            "pfs_d56.5_h238_cov",
        )


class MapperTests(unittest.TestCase):
    def test_model_from_summary_maps_the_wire_row(self):
        m = under_test.model_from_summary({
            "name": "k", "method_version": "1.0.0", "group": "g", "group_label": "G",
            "task": "pfs", "trained_on_patients": 94, "trained_at": "2026-11-14T00:00:00Z",
            "decision_day": 56.0, "endpoint": "pfs", "horizon": 238.0, "size_bytes": 5,
            "embeds_training_data": True, "own_auc": 0.7, "marker_count": 3,
            "marker_kind": {"kind": "all"}, "uses_covariates": False,
        })
        self.assertEqual(m["name"], "k")
        self.assertEqual(m["marker_kind"], "all")
        self.assertEqual(m["trained_on_patients"], 94)

    def test_column_from_response_defaults(self):
        col = under_test.column_from_response(
            {"method_id": "m"}, "train/x/m.csv", 7
        )
        self.assertEqual(col["label"], "m")
        self.assertEqual(col["prob_source"], "native")
        self.assertEqual(col["rows"], 7)


class WriterTests(unittest.TestCase):
    def test_write_bundle_emits_the_versioned_manifest_and_tables(self):
        out = tempfile.mkdtemp(dir=WORK_DIR, prefix="record-bundle-")
        try:
            manifest = under_test.write_bundle(
                out,
                {"patients": {"content_hash": "sha256:" + "a" * 64, "rows": 2,
                              "columns": ["patient_id"]}},
                [{"id": "pfs_d56_h238", "endpoint": "pfs", "decision_day": 56.0,
                  "look_ahead_day": 238.0, "covariates": False, "logs": []}],
                {"kelim": [{
                    "configuration_id": "pfs_d56_h238",
                    "seconds": 12.0,
                    "train": {"table": "train/pfs_d56_h238/kelim.csv", "label": "kelim",
                              "rows": 2},
                    "model": None,
                    "reuse": None,
                }]},
                [],
            )
            self.assertEqual(manifest["format"], under_test.FORMAT_TAG)
            self.assertEqual(manifest["version"], under_test.FORMAT_VERSION)
            self.assertEqual(manifest["dataset_id"], "example")
            self.assertEqual(len(manifest["configurations"]), 1)
            self.assertEqual(manifest["methods"][0]["method_id"], "kelim")
            self.assertTrue(os.path.exists(os.path.join(out, "manifest.json")))
        finally:
            for root, _dirs, files in os.walk(out, topdown=False):
                for f in files:
                    os.remove(os.path.join(root, f))
                if root != out:
                    os.rmdir(root)
            os.rmdir(out)


class FlowTests(unittest.TestCase):
    def test_the_recording_flow_records_the_required_configuration(self):
        out = tempfile.mkdtemp(dir=WORK_DIR, prefix="record-flow-")
        report = os.path.join(WORK_DIR, "record-flow-report.md")
        fake = FakeApp()
        real_http = under_test._http
        under_test._http = lambda app, method, path, body=None, token=None: fake.handle(
            method, path, body, token
        )
        old_poll = under_test.POLL_SECS
        under_test.POLL_SECS = 0
        try:
            rc = under_test.main(["--app-url", "http://127.0.0.1:1", "--out", out,
                                  "--report", report, "--run-timeout", "60"])
        finally:
            under_test._http = real_http
            under_test.POLL_SECS = old_poll
        self.assertEqual(rc, 0, open(report).read())
        with open(os.path.join(out, "manifest.json")) as fh:
            manifest = json.load(fh)
        self.assertEqual(manifest["format"], under_test.FORMAT_TAG)
        # The required configuration recorded; the optional one skipped.
        self.assertEqual([c["id"] for c in manifest["configurations"]], ["pfs_d56_h238"])
        (rec,) = manifest["methods"][0]["records"]
        self.assertEqual(rec["seconds"], 12.0)
        self.assertEqual(rec["configuration_id"], "pfs_d56_h238")
        self.assertIsNotNone(rec["model"])
        self.assertIsNotNone(rec["reuse"])
        self.assertEqual(rec["train"]["rows"], 94)
        train_csv = open(os.path.join(out, rec["train"]["table"])).read()
        self.assertTrue(train_csv.startswith("patient_id,probability,note\n"))
        # The fake app saw the whole flow.
        paths = [p for _m, p in fake.calls]
        for expected in ["/app/mode", "/session/local", "/methods/eligibility",
                         "/txr/runs", "/txr/models/save", "/txr/models/resolve"]:
            self.assertIn(expected, paths, f"missing step {expected}")
        report_body = open(report).read()
        self.assertIn("SKIP", report_body)
        os.remove(report)
        shutil.rmtree(out)

    def test_the_mode_probe_refuses_a_demo_mode_app(self):
        report = os.path.join(WORK_DIR, "record-mode-probe-report.md")
        real_http = under_test._http
        under_test._http = lambda app, method, path, body=None, token=None: (
            200, {"mode": "demo"}
        )
        try:
            rc = under_test.main(["--app-url", "http://127.0.0.1:1",
                                  "--report", report, "--out",
                                  os.path.join(WORK_DIR, "unused-bundle")])
        finally:
            under_test._http = real_http
        self.assertEqual(rc, 1)
        self.assertIn("DESKTOP-mode app", open(report).read())
        os.remove(report)


if __name__ == "__main__":
    unittest.main()
