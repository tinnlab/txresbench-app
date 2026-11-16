#!/usr/bin/env python3
"""Tests for scripts/demo/e2e-demo.py (demo-mode ITEM-8, TEST-DM-7's driver).

The proof drives a REAL demo server over HTTP; these unit tests run its pure
decision logic and its step order against scripted in-process transports (the
module's `_raw`/`_http` seams and a stubbed `mint_session`): they pin the
route-policy parser against the server's OWN allowlist.rs and the committed
OpenAPI spec (a route added without a classification fails HERE and in the
sweep), the sweep's 403 expectation, the request-path materialization, the
bundle-vs-predictions equality, the generated server config, and the train
path's call sequence against a fake demo server.

Unittest, stdlib only, no network, no data of any kind. The report/bundle
files each run writes go under /data/pbya/txresbench-app-work/ (never /tmp —
the repo's working-file rule) and are removed by the run.

Run: python3 scripts/demo/e2e_demo.test.py
"""

import importlib.util
import json
import os
import re
import shutil
import sys
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
_spec = importlib.util.spec_from_file_location(
    "e2e_demo_under_test", os.path.join(_HERE, "e2e-demo.py")
)
e2e = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(e2e)

#: The work-record root (the repo's working-file rule: never /tmp).
WORK_DIR = "/data/pbya/txresbench-app-work/qa-data"

#: The fixture bundle facts the fake app serves (the writer's shapes).
PATIENTS_CSV = (
    "patient_id,pfs_days,pfs_event,os_days,os_event,responder,response_day,age,sex,stage\n"
    + "\n".join(f"J{i:04d},472,1,808,1,0,35,77,M,III" for i in range(100))
    + "\n"
)
MEASUREMENTS_CSV = (
    "patient_id,day,marker,value,unit\n"
    + "\n".join(
        f"J{i // 3:04d},0,M{1 + (i % 3)},{1.0 + i / 10.0},a.u." for i in range(300)
    )
    + "\n"
)
PREDICT_CSV = (
    "patient_id,day,marker,value,unit\n"
    + "\n".join(
        f"J1{i // 3:03d},0,M{1 + (i % 3)},{1.0 + i / 10.0},a.u." for i in range(45)
    )
    + "\n"
)
INVENTORY = {
    "markers": [{"key": "M1"}, {"key": "M2"}, {"key": "M3"}],
    "patients": 94,
    "decision_day": 56,
}


def fake_manifest_and_bundle(tmp):
    """A tiny valid-composition bundle (the writer's own shape): one method,
    one configuration, 3 train + 2 reuse rows."""
    bundle = os.path.join(tmp, "bundle")
    train = os.path.join(bundle, "train", e2e.CONFIG_ID)
    reuse = os.path.join(bundle, "reuse", e2e.CONFIG_ID)
    os.makedirs(train)
    os.makedirs(reuse)
    with open(os.path.join(train, "kelim.csv"), "w", encoding="utf-8") as fh:
        fh.write("patient_id,probability,note\nJ0000,0.62,\nJ0001,0.63,\nJ0002,0.64,\n")
    with open(os.path.join(reuse, "kelim.csv"), "w", encoding="utf-8") as fh:
        fh.write("patient_id,probability,note\nJ1000,0.71,\nJ1001,0.72,\n")
    manifest = {
        "format": e2e.FORMAT_TAG if hasattr(e2e, "FORMAT_TAG") else "txresbench-demo-bundle",
        "version": 1,
        "generated_at": "2026-11-15T00:00:00Z",
        "dataset_id": "example",
        "tables": {},
        "configurations": [{"id": e2e.CONFIG_ID, "endpoint": "pfs", "decision_day": 56.0,
                            "look_ahead_day": 238.0, "covariates": False}],
        "methods": [{
            "method_id": e2e.METHOD_ID,
            "records": [{
                "configuration_id": e2e.CONFIG_ID,
                "seconds": 150.0,
                "train": {"table": f"train/{e2e.CONFIG_ID}/kelim.csv", "label": "kelim",
                          "group": "kinetics", "group_label": "Kinetics", "task": "pfs",
                          "prob_source": "native", "flat_conversion": False,
                          "coverage": {"scored": 3, "eligible": 3, "fraction": 1.0},
                          "rows": 3},
                "model": {"name": "kelim", "method_version": "1.0.0"},
                "reuse": {"table": f"reuse/{e2e.CONFIG_ID}/kelim.csv", "label": "kelim",
                          "group": "kinetics", "group_label": "Kinetics", "task": "pfs",
                          "prob_source": "native", "flat_conversion": False,
                          "coverage": {"scored": 2, "eligible": 2, "fraction": 1.0},
                          "rows": 2},
            }],
        }],
    }
    with open(os.path.join(bundle, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh)
    return manifest, bundle


class PolicyTest(unittest.TestCase):
    """The sweep's source of truth: the parser, the spec, the completeness."""

    def test_parse_route_policy_reads_the_servers_one_table(self):
        with open(e2e.ALLOWLIST_RS, encoding="utf-8") as fh:
            rows = e2e.parse_route_policy(fh.read())
        self.assertGreater(len(rows), 100, "the one table has rows")
        keys = [(m, p) for m, p, _ in rows]
        self.assertEqual(len(keys), len(set(keys)), "no duplicate (method, path)")
        for _m, _p, class_ in rows:
            self.assertIn(class_, ("allowed", "adapted", "blocked"))

    def test_spec_operations_and_policy_checks_are_complete(self):
        table, spec_keys = e2e.policy_checks()
        # A route added to the app without a row fails THIS (and the sweep).
        self.assertEqual(len({(m, p) for m, p, _ in table}), len(spec_keys))
        self.assertEqual(len(table), e2e.ALLOWED_ADAPTED_COUNT + 85,
                         "the current surface: 45 allowed/adapted + 85 blocked")

    def test_materialize_path_replaces_each_param_with_exactly_one_segment(self):
        self.assertEqual(
            e2e.materialize_path("/txr/runs/{id}/methods/{method_id}/stop"),
            "/txr/runs/demo-sweep/methods/demo-sweep/stop",
        )
        self.assertEqual(e2e.materialize_path("/health"), "/health")
        self.assertTrue(e2e.materialize_path("/txr/runs/{id}").endswith("/demo-sweep"))
        self.assertNotIn("//", e2e.materialize_path("/txr/runs/{id}/methods/{m}/stop"))

    def test_a_materialized_path_reaches_the_gate_like_the_router(self):
        # The filler is one non-empty segment — never zero segments (the
        # Rust matches_row rule) — so every blocked row stays matchable.
        for _m, p, c in e2e.parse_route_policy(
            open(e2e.ALLOWLIST_RS, encoding="utf-8").read()
        ):
            if "{" in p:
                got = e2e.materialize_path(p)
                self.assertNotIn("{", got)
                self.assertNotIn("//", got)


class BundleEqualityTest(unittest.TestCase):
    """The replay-vs-bundle equality the proof asserts."""

    def setUp(self):
        self._tmp = tempfile.mkdtemp(dir=WORK_DIR)
        self.manifest, self.bundle = fake_manifest_and_bundle(self._tmp)

    def tearDown(self):
        shutil.rmtree(self._tmp, ignore_errors=True)

    def test_rows_equal_matches_order_patient_and_probability(self):
        record = e2e.bundle_record(self.manifest, e2e.CONFIG_ID, e2e.METHOD_ID)
        expected = e2e.bundle_table_rows(self.bundle, record["train"]["table"])
        pred = {
            "patients": ["J0000", "J0001", "J0002"],
            "methods": [{"method_id": "kelim",
                         "probabilities": [0.62, 0.63, 0.64]}],
        }
        e2e.assert_rows_equal("train", expected, e2e.predictions_rows(pred))

    def test_rows_equal_fails_on_a_different_value_or_order(self):
        record = e2e.bundle_record(self.manifest, e2e.CONFIG_ID, e2e.METHOD_ID)
        expected = e2e.bundle_table_rows(self.bundle, record["train"]["table"])
        with self.assertRaises(AssertionError):
            e2e.assert_rows_equal("train", expected, e2e.predictions_rows({
                "patients": ["J0000", "J0001", "J0002"],
                "methods": [{"method_id": "kelim", "probabilities": [0.62, 0.62, 0.64]}],
            }))
        with self.assertRaises(AssertionError):
            e2e.assert_rows_equal("train", expected, e2e.predictions_rows({
                "patients": ["J0002", "J0001", "J0000"],
                "methods": [{"method_id": "kelim", "probabilities": [0.64, 0.63, 0.62]}],
            }))

    def test_bundle_record_refuses_an_unrecorded_pair(self):
        with self.assertRaises(e2e.StepFail):
            e2e.bundle_record(self.manifest, "os_d56_h238", e2e.METHOD_ID)


class ConfigTest(unittest.TestCase):
    """The generated demo config (run-demo.sh's document; the e2e's own)."""

    def test_config_carries_the_demo_block_and_the_limits(self):
        tmp = tempfile.mkdtemp(dir=WORK_DIR)
        try:
            cfg = e2e.write_server_config(tmp, "/bundle/path", 3199, 150.0,
                                          "https://example.org/download")
            text = open(cfg, encoding="utf-8").read()
            self.assertIn("port: 3199", text)
            self.assertIn("enabled: true", text)
            self.assertIn("history_limit: 50", text)
            self.assertIn("model_limit: 50", text)
            self.assertIn("replay_speed: 150.0", text)
            self.assertIn('bundle_path: "/bundle/path"', text)
            self.assertIn("trust_forwarded_headers: true", text)
            self.assertIn("txresbench.db", text)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class ScriptedServer:
    """One in-process demo-app transport for the train path: records every
    call and answers by path (the same contract shapes the real server's
    tests assert)."""

    def __init__(self):
        self.calls = []
        self.sweep_403s = True
        self._run_stage = 0

    def raw(self, app, method, path, body=None, token=None, cookie=None):
        self.calls.append((method, path))
        if path == "/app/mode":
            return 200, {"mode": "demo", "download_url": "https://example.org",
                         "limits": {"history": 50, "models": 50}, "notice": "demo_banner"}
        if path.startswith("/file-validation/examples/"):
            kind = path.rsplit("/", 1)[1]
            csv_text = {"patients": PATIENTS_CSV, "measurements": MEASUREMENTS_CSV,
                        "predict-measurements": PREDICT_CSV}[kind]
            return 200, csv_text.encode("utf-8")
        if path == "/file-validation/inspect":
            return 200, {"problems": []}
        if path == "/file-validation/validate":
            return 200, {
                "problems": [],
                "markers": [{"key": "M1"}, {"key": "M2"}, {"key": "M3"}],
                "measurements": {"rows": 300, "patients": 100},
                "patients": {"rows": 100},
                "inventory": INVENTORY,
            }
        if path == "/methods/eligibility":
            return 200, {"methods": [{"id": "kelim", "status": "can_run",
                                      "estimated_seconds": 15.0}],
                         "total_cannot": 100}
        if path == "/methods/estimate":
            return 200, {"methods": [{"id": "kelim", "estimated_seconds": 15.0,
                                      "estimate_quality": "measured"}],
                         "total_seconds": 15}
        if path == "/txr/runs" and method == "POST":
            self._run_stage = 0
            return 202, {"id": "r-fake", "status": "preparing",
                         "config": {"decision_day": 56.0}}
        if path == "/txr/runs/r-fake" and method == "GET":
            self._run_stage += 1
            if self._run_stage == 1:
                return 200, {"id": "r-fake", "status": "running", "mode": "train",
                             "methods": [{"method_id": "kelim", "state": "running",
                                          "task": "pfs"}]}
            return 200, {"id": "r-fake", "status": "finished", "mode": "train",
                         "methods": [{"method_id": "kelim", "state": "finished",
                                      "task": "pfs", "prob_source": "native",
                                      "coverage": {"scored": 3}, "bytes_total": None,
                                      "elapsed_secs": 2.0}]}
        if path == "/txr/runs/r-fake/predictions":
            return 200, {"endpoint": "pfs", "horizon": 238.0,
                         "patients": ["J0000", "J0001", "J0002"],
                         "methods": [{"method_id": "kelim",
                                      "probabilities": [0.62, 0.63, 0.64],
                                      "coverage": {"scored": 3}}]}
        if path == "/txr/runs/r-fake/predictions.csv":
            return 200, b"patient_id,probability,note\nJ0000,0.62,\nJ0001,0.63,\nJ0002,0.64,\n"
        if path == "/txr/models/save":
            return 201, {"set": {"id": "s-fake", "name": "Demo models 2026-11-15 00:00:00"},
                         "models": [{"id": "m-fake", "method_id": "kelim",
                                     "size_bytes": 1024}]}
        if path == "/txr/model-sets":
            return 200, {"sets": [{"id": "s-fake"}]}
        if path == "/txr/pretrained":
            return 200, {"models": []}
        if path == "/txr/runs":
            return 200, {"runs": [{"id": "r-fake"}], "total": 1}
        if path == "/txr/models":
            return 200, {"models": [{"id": "m-fake", "set_id": "s-fake"}]}
        if path.endswith("/stop") or path.endswith("/skip"):
            if self.sweep_403s:
                return 403, {"error_code": "DEMO_MODE",
                             "error": "This is not available in the demo"}
            return 202, {}
        # The sweep's default: every unhandled path answers the DEMO_MODE
        # bytes, or a plain 200 when the test wants the sweep to fail.
        if self.sweep_403s:
            return 403, {"error_code": "DEMO_MODE",
                         "error": "This is not available in the demo"}
        return 200, {"ok": True}


class TrainPathTest(unittest.TestCase):
    """The P1 step's call sequence against a scripted demo server (the same
    contract shapes the server's own demo tests assert)."""

    def setUp(self):
        self._tmp = tempfile.mkdtemp(dir=WORK_DIR)
        self.manifest, self.bundle = fake_manifest_and_bundle(self._tmp)
        self.fake = ScriptedServer()
        saved_raw, saved_http = e2e._raw, e2e._http
        self._saved = (saved_raw, saved_http)
        e2e._raw = e2e._http = self.fake.raw

    def tearDown(self):
        e2e._raw, e2e._http = self._saved
        shutil.rmtree(self._tmp, ignore_errors=True)

    def test_train_path_sequence_and_equality(self):
        ctx = e2e.Walk("http://fake", self.manifest, self.bundle)
        ctx.token_a = "token-a"
        ctx.cookie_a = "txr_demo_session=x"
        ctx.validation = {
            "inventory": INVENTORY,
            "patients": {"rows": 100},
            "markers": [{"key": "M1"}, {"key": "M2"}, {"key": "M3"}],
        }
        patients = e2e.table_from_csv_text(PATIENTS_CSV, "patients.csv")
        measurements = e2e.table_from_csv_text(MEASUREMENTS_CSV, "measurements.csv")
        e2e.step_train_path(ctx, patients, measurements)
        self.assertEqual(ctx.run_id, "r-fake")
        self.assertEqual(ctx.model_id, "m-fake")
        self.assertEqual(ctx.set_id, "s-fake")
        sequence = [f"{m} {p}" for m, p in self.fake.calls]
        self.assertEqual(
            sequence,
            [
                "POST /methods/eligibility",
                "POST /methods/estimate",
                "POST /txr/runs",
                "GET /txr/runs/r-fake",
                "GET /txr/runs/r-fake",
                "GET /txr/runs/r-fake/predictions",
                "GET /txr/runs/r-fake/predictions.csv",
                "POST /txr/models/save",
                "GET /txr/model-sets",
            ],
        )

    def test_the_sweep_requires_demo_mode_bytes(self):
        self.fake.calls.clear()
        self.fake.sweep_403s = True
        original = e2e.policy_checks
        calls = []

        def three_blocks(spec_keys=()):
            calls.append(("policy", spec_keys))
            return ([
                ("GET", "/files", "blocked"),
                ("POST", "/notifications/read-all", "blocked"),
                ("DELETE", "/account-invitations/accept", "blocked"),
            ], set(spec_keys))

        # 48 spec operations, 45 allowed/adapted, 3 blocked -> the count holds.
        e2e.policy_checks = lambda: three_blocks(range(48))
        try:
            line = e2e.step_sweep("http://fake")
            self.assertIn("3 blocked", line)
            # A single 200 instead of 403 fails the sweep.
            self.fake.sweep_403s = False
            with self.assertRaises(AssertionError):
                e2e.step_sweep("http://fake")
        finally:
            e2e.policy_checks = original
        self.assertEqual(calls[0][0], "policy")


if __name__ == "__main__":
    unittest.main()
