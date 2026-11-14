#!/usr/bin/env python3
"""Tests for the --example mode of scripts/dev-registry/e2e-real.py
(qa-fixes3 ITEM-5, TEST-QF3-3's driver half).

The script drives a RUNNING app over HTTP; these unit tests run the mode's
step logic against a scripted in-process transport (the module's `_http`
seam — the import of the driver replaces that one attribute, nothing else):
they pin the THREE example flows' step order and the contract assertions
(the family facts, the eligibility/estimate pass-through, the ITEM-3 pick)
without a server, and the two honest SKIP branches (a catalogue-less app;
an example set the host cannot train — the `failed` answer).

Unittest, stdlib only, no network, no data of any kind. The report file of
each run is written under /data/pbya/txresbench-app-work/ (never /tmp —
the repo's working-file rule), and removed by the run.

Run: python3 scripts/dev-registry/e2e_real.test.py
"""

import importlib.util
import json
import os
import sys
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
_spec = importlib.util.spec_from_file_location(
    "e2e_real_under_test", os.path.join(_HERE, "e2e-real.py")
)
e2e_real = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(e2e_real)

#: The work-record root (the repo's working-file rule: never /tmp).
WORK_DIR = "/data/pbya/txresbench-app-work/qa-data"


def predict_csv(patients=15, markers=("M1", "M2", "M3")):
    lines = ["patient_id,day,marker,value,unit"]
    for n in range(patients):
        for day in ("-14", "0", "21", "42", "56", "84"):
            for marker in markers:
                lines.append(f"J{1000 + n},{day},{marker},1.0,a.u.")
    return "\n".join(lines)


def patients_csv(patients=100):
    lines = ["patient_id,pfs_days,pfs_event,os_days,os_event,responder,response_day,age,sex,stage"]
    for n in range(patients):
        lines.append(f"J{n:04d},472,1,808,1,0,35,77,M,III")
    return "\n".join(lines)


def training_csv(patients=100, markers=("M1", "M2", "M3")):
    lines = ["patient_id,day,marker,value,unit"]
    for n in range(patients):
        for day in ("-28", "-14", "0", "21", "42", "56", "84", "126", "252", "336"):
            for marker in markers:
                lines.append(f"J{n:04d},{day},{marker},1.0,a.u.")
    return "\n".join(lines)


def validate_body(table_rows, mode):
    markers = [{"key": "M1"}, {"key": "M2"}, {"key": "M3"}]
    return {
        "problems": [],
        "markers": markers,
        "measurements": {"rows": table_rows, "patients": 15, "distinct_draw_days": [0, 21]},
        "patients": {"rows": 100} if mode == "files" else None,
        "inventory": {"markers": markers, "patients": 100, "decision_day": 56},
    }


class ScriptedServer:
    """One in-process transport: records every call, answers by path."""

    def __init__(self, pretrained_empty=False, example_states=("creating", "ready")):
        self.calls = []
        self.pretrained_empty = pretrained_empty
        self.example_states = list(example_states)
        self._payloads = {
            "predict-measurements": predict_csv(),
            "patients": patients_csv(),
            "measurements": training_csv(),
        }
        self.predict_rows = len(self._payloads["predict-measurements"].splitlines()) - 1
        self.training_rows = len(self._payloads["measurements"].splitlines()) - 1

    def __call__(self, app, method, path, body=None, token=None):
        self.calls.append((method, path, body))
        if path == "/health":
            return 200, {"status": "ok"}
        if path == "/session/local":
            return 200, {"access_token": "tok"}
        if method == "GET" and path.startswith("/file-validation/examples/"):
            kind = path.rsplit("/", 1)[1]
            return 200, self._payloads[kind].encode("utf-8")
        if path == "/file-validation/inspect":
            return 200, {"problems": [], "summary": {"rows": self.predict_rows,
                                                     "markers": [], "draw_days": []}}
        if path == "/file-validation/validate":
            return 200, validate_body(self.predict_rows, (body or {}).get("mode") or "predict")
        if path == "/txr/pretrained":
            if self.pretrained_empty:
                return 200, {"models": [], "total": 0, "generated_from": {"dataset": "x"}}
            return 200, {"models": [{"id": "pre-1", "name": "One"}], "total": 1,
                         "generated_from": {"dataset": "x"}}
        if path == "/txr/pretrained/eligibility":
            body = body or {}
            statuses = ["can_run"] * len(body.get("model_ids", []))
            return 200, {"models": [{"model_id": i, "status": s}
                                    for i, s in enumerate(statuses)],
                         "total_fit": len(statuses), "total_some": 0, "total_cannot": 0}
        if path == "/methods/eligibility":
            return 200, {"methods": [{"id": "m", "status": "can_run"}], "total_fit": 1}
        if path == "/methods/estimate":
            body = body or {}
            return 200, {"methods": [{"id": i, "estimated_seconds": 5.0}
                                     for i in body.get("method_ids", [])],
                         "total_seconds": 15.0, "schedule_seconds": 5.0}
        if path == "/txr/models/example":
            if self.example_states:
                state = self.example_states.pop(0)
            else:
                state = "ready"
            if state == "failed":
                return 200, {"state": "failed", "methods": e2e_real.EXAMPLE_PICK,
                             "error": "the example training run failed — the environment "
                                      "layer could not be fetched on this host"}
            if state == "ready":
                return 200, {"state": "ready", "methods": e2e_real.EXAMPLE_PICK,
                             "set_id": "11111111-2222-3333-4444-555555555555"}
            return 200, {"state": "creating", "methods": e2e_real.EXAMPLE_PICK,
                         "run_id": "r1", "run_status": "running"}
        if path.startswith("/txr/models?set_id="):
            set_id = path.split("=", 1)[1]
            return 200, {"models": [{"id": "md-1", "set_id": set_id, "method_id": "kelim"}],
                         "total": 1, "models_dir": None}
        if path == "/txr/model-sets":
            return 200, {"sets": [{"id": "11111111-2222-3333-4444-555555555555",
                                   "name": "Example models", "model_count": 3,
                                   "created_at": "2026-01-01T00:00:00Z"}], "total": 1}
        raise AssertionError(f"unexpected call: {method} {path} {body}")

    def paths(self):
        return [f"{m} {p}" for m, p, _ in self.calls]


class ExampleModeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=WORK_DIR)
        self.work = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def run_main(self, server):
        e2e_real._http = server
        report = os.path.join(self.work, "report.md")
        return e2e_real.main(["--example", "--report", report]), report

    def read_report(self, report):
        with open(report) as fh:
            return fh.read()

    def test_happy_path_runs_the_three_example_flows_in_order(self):
        server = ScriptedServer()
        code, report = self.run_main(server)
        text = self.read_report(report)
        self.assertEqual(code, 0, text)
        for needle in [
            "PASS  1 health",
            "PASS  2 local session",
            "PASS  E1 example predict table",
            "PASS  E1 inspect",
            "PASS  E1 validate (predict mode)",
            "PASS  E2 example training tables",
            "PASS  E2 inspect",
            "PASS  E2 validate (files mode)",
            "PASS  E2 eligibility",
            "PASS  E2 estimate (the example pick)",
            "PASS  E3 validate (predict mode)",
            "PASS  E3 example set (call 1)",
            "PASS  E3 example set ready + its models",
            "PASS  16 summary",
        ]:
            self.assertIn(needle, text)
        # The step order: the example table calls precede the validate calls;
        # the app's own pick (the set call) is read after the eligibility and
        # before the estimate, which is asked for that pick.
        paths = server.paths()
        self.assertLess(
            paths.index("GET /file-validation/examples/predict-measurements"),
            paths.index("POST /file-validation/validate"),
        )
        self.assertLess(
            paths.index("POST /methods/eligibility"),
            paths.index("POST /txr/models/example"),
        )
        self.assertLess(
            paths.index("POST /txr/models/example"),
            paths.index("POST /methods/estimate"),
        )

    def test_empty_pretrained_catalogue_is_an_honest_skip(self):
        server = ScriptedServer(pretrained_empty=True)
        code, report = self.run_main(server)
        text = self.read_report(report)
        self.assertEqual(code, 0, text)
        self.assertIn("SKIP  E1 pretrained catalogue + eligibility", text)
        self.assertIn("no pretrained catalogue", text)
        self.assertIn("PASS  16 summary", text)

    def test_failed_example_set_is_an_honest_skip(self):
        server = ScriptedServer(example_states=("creating", "creating", "failed"))
        code, report = self.run_main(server)
        text = self.read_report(report)
        self.assertEqual(code, 0, text)
        self.assertIn("SKIP  E3 example set ready", text)
        self.assertIn("no real environment stack", text)
        self.assertIn("PASS  16 summary", text)

    def test_the_pick_pin_and_the_family_facts_hold(self):
        self.assertEqual(len(e2e_real.EXAMPLE_PICK), 3)
        self.assertEqual(e2e_real.EXAMPLE_PREDICT_PATIENTS, 15)
        self.assertEqual(e2e_real.EXAMPLE_TRAINING_PATIENTS, 100)
        self.assertEqual(e2e_real.EXAMPLE_DECISION_DAY, 56)
        self.assertEqual(tuple(sorted(e2e_real.EXAMPLE_MARKERS)), ("m1", "m2", "m3"))
        # The example-set endpoint's own pick is pinned to the documented
        # pick (step E3); the estimate step asks for the same ids.
        table = e2e_real.table_from_csv_text(predict_csv(), "p.csv")
        self.assertEqual(len(table["rows"]), 15 * 6 * 3)
        self.assertEqual(table["header_row"], 1)
        keys = e2e_real.marker_keys(
            {"markers": [{"key": "M1"}, {"key": "M2"}, {"key": "M3"}]}
        )
        self.assertEqual(keys, ["m1", "m2", "m3"])


if __name__ == "__main__":
    os.makedirs(WORK_DIR, exist_ok=True)
    unittest.main(verbosity=2)
