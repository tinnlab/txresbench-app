#!/usr/bin/env python3
"""e2e-real — ITEM-3 (node qa-hardening): drive the running TxResBench app over
its HTTP API exactly like the UI does, on REAL open data with REAL published
method environments served by the dev registry.

WHAT IT DOES (one line per step, exit non-zero on the first failure):
  1. health check                                GET  /api/health
  2. local owner session (no login)              POST /api/session/local
  3. load the ITEM-3 inputs                       patients.csv / measurements.csv /
                                                   predict-measurements.csv / inputs.json
                                                   (make-real-inputs.py's product)
  4. file inspection (both files)                POST /api/file-validation/inspect
  5. validation (mapping applied)                POST /api/file-validation/validate
  6. eligibility (the validate inventory)        POST /api/methods/eligibility
  7. estimate                                    POST /api/methods/estimate
  8. create run (train, the published methods)   POST /api/txr/runs
  9. follow to the end                           GET  /api/txr/runs/{id}
 10. predictions (JSON + CSV)                    GET /api/txr/runs/{id}/predictions[.csv]
 11. save the produced models                    POST /api/txr/models/save
 12. resolve + reuse on the predict-only file    POST /api/txr/models/resolve,
                                                POST /api/txr/runs (mode: reuse)
 13. reuse follow + per-patient equality check
 14. history (both runs)                         GET /api/txr/history, /api/txr/runs

The app must already be running against the dev registry (debug build with
CYTO_TXR_METHOD_ENV_REGISTRY + CYTO_TXR_ENV_MANIFEST set — the README's
"Start the app against it"). The dev registry must be up too.

RUN
---
    python3 scripts/dev-registry/e2e-real.py
    python3 scripts/dev-registry/e2e-real.py --app-url http://127.0.0.1:3100

The report is written to /data/pbya/txresbench-app-work/qa-data/e2e-real-report.md
(default) and mirrored on stdout; the exit code is 0 only when every step and
every assertion passes.
"""

import argparse
import csv
import json
import os
import sys
import time
import urllib.error
import urllib.request

#: The default app URL (the dev server config: 127.0.0.1:3100).
DEFAULT_APP_URL = "http://127.0.0.1:3100"
#: The default input dir (make-real-inputs.py's default dataset + app dir).
DEFAULT_INPUTS = "/data/pbya/txresbench-app-work/qa-data/Bratman2020_INSPIRE-ctDNA-app"
#: The default report path (DEC-1: outside the repo).
DEFAULT_REPORT = "/data/pbya/txresbench-app-work/qa-data/e2e-real-report.md"
#: The six published methods (ITEM-2's REAL_METHODS, after ITEM-3's
#: correction: `linear-response-score` is gate-failed, absent from the app's
#: catalogue AND its shipped env manifest — it was removed from the dev
#: publish; the gate-passing `ctdna-anytime-detectability` replaced it, so
#: the plan's "at least six real methods" still holds).
PUBLISHED_METHODS = [
    "cfmedip-ctdna-clearance-three-group",
    "cox-baseline-delta",
    "ctdna-anytime-detectability",
    "ctdna-clearance",
    "ctdna-week4-rise-or-emergence",
    "landmark-cox-current",
]
#: Run settings (board E defaults; save_models ON so step 11 has models).
RUN_CONFIG = {
    "endpoint": "pfs",
    "decision_day": 56,
    "look_ahead_day": 238,
    "covariates": False,
    "at_a_time": 2,
    "cpus": None,
    "save_models": True,
    "label_day": None,
}
#: Minutes before a run is declared a failure (heavy machine; the worked
#: example totals are minutes, and each sandbox base pull is hundreds of MB).
RUN_TIMEOUT_SECS = 45 * 60
POLL_SECS = 5


class StepFail(RuntimeError):
    pass


def http(app, method, path, body=None, token=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(app + "/api" + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token is not None:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read()
            ctype = resp.headers.get("content-type", "")
            if "json" in ctype:
                return resp.status, json.loads(raw)
            return resp.status, raw
    except urllib.error.HTTPError as e:
        raise StepFail(f"{method} {path} -> {e.code}: {e.read().decode()[:500]}")


def table_from_csv(path):
    with open(path, newline="") as fh:
        rd = csv.reader(fh)
        columns = next(rd)
        rows = [[c if c != "" else None for c in row] for row in rd]
    return {
        "columns": columns,
        "header_row": 1,
        "rows": rows,
        "source": {"format": "csv", "name": os.path.basename(path)},
    }


def error_problems(problems):
    return [p for p in problems if p.get("severity") == "error"]


def follow_run(app, token, run_id, timeout_secs):
    deadline = time.time() + timeout_secs
    detail = None
    while time.time() < deadline:
        _, detail = http(app, "GET", f"/txr/runs/{run_id}", token=token)
        if detail.get("status") in ("finished", "failed", "stopped"):
            return detail
        time.sleep(POLL_SECS)
    raise StepFail(f"run {run_id} did not reach a terminal state within {timeout_secs}s")


def linear_probs(detail):
    """Per-method probabilities from a run detail (the predictions tab data)."""
    return detail.get("methods", [])


def main(argv=None):
    ap = argparse.ArgumentParser(description="TxResBench ITEM-3 real-data e2e driver")
    ap.add_argument("--app-url", default=DEFAULT_APP_URL)
    ap.add_argument("--inputs", default=DEFAULT_INPUTS)
    ap.add_argument("--report", default=DEFAULT_REPORT)
    ap.add_argument("--timeout", type=int, default=RUN_TIMEOUT_SECS)
    args = ap.parse_args(argv)

    app = args.app_url.rstrip("/")
    lines = []
    ok = True

    def step(name, fn):
        nonlocal ok
        try:
            out = fn()
            lines.append(f"PASS  {name}")
            if out is not None:
                lines.append(f"      {out}")
            return out
        except StepFail as e:
            lines.append(f"FAIL  {name}: {e}")
            ok = False
            raise
        except AssertionError as e:
            lines.append(f"FAIL  {name}: assertion failed: {e}")
            ok = False
            raise StepFail(f"{name}: assertion failed")

    try:
        # 1. health
        def s_health():
            st, body = http(app, "GET", "/health")
            assert st // 100 == 2 and body.get("status") == "ok", body
            return "app healthy"
        step("1 health", s_health)

        # 2. session
        token = None
        def s_session():
            nonlocal token
            st, body = http(app, "POST", "/session/local", {})
            assert st // 100 == 2 and body.get("access_token"), body
            token = body["access_token"]
            return "owner session minted"
        step("2 local session", s_session)

        # 3. inputs
        inputs_path = os.path.join(args.inputs, "inputs.json")
        with open(inputs_path) as fh:
            facts = json.load(fh)
        patients = table_from_csv(os.path.join(args.inputs, "patients.csv"))
        measurements = table_from_csv(os.path.join(args.inputs, "measurements.csv"))
        predict = table_from_csv(os.path.join(args.inputs, "predict-measurements.csv"))
        mapping = facts["marker_mapping"]
        step("3 inputs loaded", lambda: (
            f"{facts['dataset']}: {len(patients['rows'])} patients, "
            f"{len(measurements['rows'])} measurement rows, "
            f"{len(predict['rows'])} predict rows, markers {facts['markers']}"
        ))

        # 4. inspect
        def s_inspect():
            for kind, table in (("patients", patients), ("measurements", measurements)):
                st, ins = http(app, "POST", "/file-validation/inspect",
                               {"kind": kind, "table": table}, token)
                assert st // 100 == 2, ins
                errs = error_problems(ins.get("problems", []))
                assert not errs, f"{kind}: {errs}"
            return "no error problems in either inspect"
        step("4 inspect", s_inspect)

        # 5. validate
        validation = {}
        def s_validate():
            nonlocal validation
            st, body = http(app, "POST", "/file-validation/validate", {
                "mode": "files",
                "patients": patients,
                "measurements": measurements,
                "joins": [],
                "mapping": mapping,
                "parameters": {"decision_day": 56, "baseline_max_day": 0},
            }, token)
            assert st // 100 == 2, body
            errs = error_problems(body.get("problems", []))
            assert not errs, errs
            validation = body
            return (f"{len(validation.get('markers', []))} marker columns, "
                    f"{len(validation.get('problems', []))} warnings")
        step("5 validate", s_validate)

        # 6. eligibility
        eligibility = {}
        def s_eligibility():
            nonlocal eligibility
            st, body = http(app, "POST", "/methods/eligibility",
                            {"inventory": validation["inventory"]}, token)
            assert st // 100 == 2, body
            eligibility = body
            verdicts = {m["id"]: m for m in body["methods"]}
            rows = []
            for mid in PUBLISHED_METHODS:
                v = verdicts[mid]
                rows.append(f"{mid}: {v['status']} ({', '.join(r['code'] for r in v.get('reasons', [])) or 'ok'})")
            runnable = [mid for mid in PUBLISHED_METHODS
                        if verdicts[mid]["status"] in ("can_run", "can_run_some")]
            assert len(runnable) >= 3, f"only {len(runnable)} published methods runnable: {runnable}"
            return "runnable: " + ", ".join(runnable) + " | " + " | ".join(rows)
        step("6 eligibility", s_eligibility)

        # 7. estimate
        estimated = None
        def s_estimate():
            nonlocal estimated
            st, body = http(app, "POST", "/methods/estimate", {
                "method_ids": PUBLISHED_METHODS,
                "patients": len(patients["rows"]),
                "cpus": 2,
            }, token)
            assert st // 100 == 2, body
            estimated = body
            return (f"{len(body['methods'])} methods, total {body['total_seconds']:.0f}s, "
                    f"schedule {body['schedule_seconds']:.0f}s at {body['at_a_time']} at a time")
        step("7 estimate", s_estimate)

        # 8. create run
        run_id = None
        def s_create():
            nonlocal run_id
            st, body = http(app, "POST", "/txr/runs", {
                "mode": "train",
                "input": {
                    "patients": patients,
                    "measurements": measurements,
                    "predict_measurements": None,
                    "joins": [],
                    "mapping": mapping,
                    "keep_copies": True,
                },
                "config": RUN_CONFIG,
                "method_ids": PUBLISHED_METHODS,
            }, token)
            assert st == 202, body
            run_id = body["id"]
            return f"run {run_id} accepted (status {body.get('status')})"
        step("8 create run", s_create)

        # 9. follow
        detail = None
        def s_follow():
            nonlocal detail
            detail = follow_run(app, token, run_id, args.timeout)
            counts = detail["counts"]
            assert detail["status"] == "finished", (
                f"run failed: {detail.get('status')} — rows: "
                + ", ".join(f"{m['method_id']}={m['state']}:{m.get('reason')}"
                            for m in detail.get("methods", []))
            )
            per = {m["method_id"]: m for m in detail.get("methods", [])}
            finished = [mid for mid in PUBLISHED_METHODS if per.get(mid, {}).get("state") == "finished"]
            assert len(finished) >= 3, f"only {len(finished)} methods finished: {finished}"
            lines.append("      " + " | ".join(
                f"{mid}={per[mid]['state']}"
                + (f":{per[mid].get('reason')}" if per[mid]['state'] != "finished" else "")
                for mid in PUBLISHED_METHODS))
            return (f"run finished; counts {json.dumps(counts)}; "
                    f"{len(finished)} finished: {', '.join(finished)}")
        step("9 follow run", s_follow)

        # 10. predictions JSON + CSV
        predictions = {}
        csv_rows = None
        def s_predictions():
            nonlocal predictions, csv_rows
            st, body = http(app, "GET", f"/txr/runs/{run_id}/predictions", token=token)
            assert st // 100 == 2, body
            predictions = body
            st, raw = http(app, "GET", f"/txr/runs/{run_id}/predictions.csv", token=token)
            assert st // 100 == 2 and isinstance(raw, bytes), st
            text = raw.decode("utf-8")
            csv_rows = list(csv.reader(text.splitlines()))
            non_null = sum(
                1 for m in predictions.get("methods", [])
                if any(v is not None for v in m.get("probabilities", [])))
            assert non_null >= 3, f"{non_null} method columns with values"
            assert len(csv_rows) >= 2, "predictions.csv has no rows"
            return (f"{len(predictions.get('patients', []))} patients, "
                    f"{non_null} method columns with values, csv {len(csv_rows) - 1} rows")
        step("10 predictions", s_predictions)

        # 11. save models
        saved = {}
        def s_save():
            nonlocal saved
            per = {m["method_id"]: m for m in detail.get("methods", [])}
            finished = [mid for mid in PUBLISHED_METHODS if per.get(mid, {}).get("state") == "finished"]
            st, body = http(app, "POST", "/txr/models/save", {
                "run_id": run_id,
                "method_ids": finished,
                "target": {"set_name": f"qa-hardening-inspire-{run_id[:8]}"},
                "keep_training_files": False,
                "also_export": False,
            }, token)
            assert st // 100 == 2, body
            saved = body
            assert len(body.get("models", [])) >= 3, body
            return (f"set {body['set'].get('id')} '{body['set'].get('name')}': "
                    f"{len(body['models'])} models saved")
        step("11 save models", s_save)

        # 12. resolve + reuse run
        reuse_id = None
        reuse_detail = None
        def s_reuse():
            nonlocal reuse_id, reuse_detail
            model_ids = [m["id"] for m in saved["models"]]
            st, body = http(app, "POST", "/txr/models/resolve", {"model_ids": model_ids}, token)
            assert st // 100 == 2, body
            assets = body.get("assets", [])
            assert len(assets) >= 3, f"resolved only {len(assets)} assets"
            first = saved["models"][0]
            st, body = http(app, "POST", "/txr/runs", {
                "mode": "reuse",
                "input": {
                    "patients": None,
                    "measurements": predict,
                    "predict_measurements": predict,
                    "joins": [],
                    "mapping": mapping,
                    "keep_copies": True,
                },
                "config": {
                    "endpoint": first.get("endpoint") or "pfs",
                    "decision_day": 56,
                    "look_ahead_day": first.get("horizon") or 238,
                    "covariates": False,
                    "at_a_time": 2,
                    "cpus": None,
                    "save_models": False,
                    "label_day": None,
                },
                "model_ids": assets,
            }, token)
            assert st == 202, body
            reuse_id = body["id"]
            return f"reuse run {reuse_id} accepted ({body.get('status')})"
        step("12 resolve + reuse run", s_reuse)

        def s_reuse_follow():
            nonlocal reuse_detail
            reuse_detail = follow_run(app, token, reuse_id, args.timeout)
            assert reuse_detail["status"] == "finished", (
                f"reuse run failed: {reuse_detail.get('status')}"
            )
            return "reuse run finished"
        step("13 reuse follow", s_reuse_follow)

        # 14. per-patient equality train vs reuse (the same input table; the
        # design: a predict-only reuse has NO training data to refit the
        # risk->probability conversion — native-probability methods are
        # compared value-for-value, risk-only methods must carry the honest
        # prob_source "none" + the missing-source note, never an invented
        # number).
        def s_compare():
            _, reuse_pred = http(app, "GET", f"/txr/runs/{reuse_id}/predictions", token=token)
            model_of = {m["id"]: m["method_id"] for m in saved["models"]}
            per_train = {m["method_id"]: m for m in predictions.get("methods", [])}
            assert reuse_pred.get("patients") == predictions.get("patients"),                 "reuse predictions must be on the same patient set"
            compared = 0
            worst = 0.0
            honest_none = 0
            for rm in reuse_pred.get("methods", []):
                mid = model_of.get(rm.get("method_id"), rm.get("method_id"))
                tm = per_train.get(mid)
                if tm is None:
                    continue
                if rm.get("prob_source") == "native":
                    for a, b in zip(tm.get("probabilities", []), rm.get("probabilities", [])):
                        if a is None or b is None:
                            continue
                        compared += 1
                        worst = max(worst, abs(a - b))
                elif rm.get("prob_source") == "none":
                    note = " ".join(n for n in rm.get("notes", []) if n)
                    assert "predict-only reuse" in note, f"{mid}: {rm.get('notes')}"
                    assert all(v is None for v in rm.get("probabilities", [])), mid
                    honest_none += 1
            assert compared > 0, "no native probabilities compared"
            assert worst < 1e-9, f"reuse predictions diverge (max |diff| {worst})"
            return (f"{compared} native per-patient probabilities equal "
                    f"(max |diff| {worst:.2e}); {honest_none} risk-only columns "
                    "carry the honest prob_source none")
        step("14 reuse equality", s_compare)

        # 15. history
        def s_history():
            st, body = http(app, "GET", "/txr/history", token=token)
            assert st // 100 == 2, body
            ids = [i.get("id") for i in body.get("items", [])]
            st, runs = http(app, "GET", "/txr/runs", token=token)
            assert st // 100 == 2, runs
            run_ids = [r.get("id") for r in runs.get("runs", [])]
            assert run_id in run_ids and reuse_id in run_ids, "runs missing from history"
            st, det = http(app, "GET", f"/txr/history/{run_id}", token=token)
            assert st // 100 == 2, det
            return f"{len(run_ids)} runs in history ({len(set(ids))} history rows); detail ok"
        step("15 history", s_history)

        step("16 summary", lambda: "ALL STEPS PASSED")
    except StepFail:
        pass
    except Exception as e:  # never lose the partial report to an unhandled error
        lines.append(f"FAIL  unexpected: {type(e).__name__}: {e}")
        ok = False

    report = "\n".join(lines)
    os.makedirs(os.path.dirname(args.report), exist_ok=True)
    with open(args.report, "w") as fh:
        fh.write("# e2e-real report\n\n" + report + "\n")
    print(report)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
