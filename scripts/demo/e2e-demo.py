#!/usr/bin/env python3
"""e2e-demo — demo-mode ITEM-8: the deployment proof of the TxResBench demo.

Drives the demo service over its HTTP API exactly as a browser visitor does —
the three paths (train, reuse, pretrained) plus the plan's five proof
checks — against a REAL txresbench binary running in demo mode. By default
the script boots its own demo server (a scratch data dir + a minimal valid
recorded bundle); `--app-url` attaches to a running demo service instead.

WHAT IT DOES (one line per step, exit non-zero on the first failure):
  1. mode probe                                   GET  /api/app/mode
  2. anonymous session (A)                        POST /api/session/local
  3. S1 blocked-route sweep                       every OpenAPI operation NOT
     classified allowed/adapted answers 403 DEMO_MODE (the table is parsed
     from the server's own allowlist.rs; the sweep re-asserts its
     completeness against the committed OpenAPI spec first)
  4. S2 an upload attempt fails                   inspect/validate with a
     non-example table answers 403 DEMO_MODE
  5. P1 train path: examples -> inspect -> validate -> eligibility ->
     estimate -> POST /txr/runs -> the replay (preparing -> running ->
     finished) -> predictions JSON + CSV EQUAL THE BUNDLE -> save models
     (the generated name)
  6. P2 reuse path: POST /txr/models/example (the seeded, PINNED example
     set) -> resolve -> reuse replay run -> predictions equal the bundle's
     reuse table
  7. P3 pretrained path: the catalogue + eligibility; a catalogue-like
     deployment with zero entries (this tree's compiled-in catalogue) is
     the honest SKIP, never a fabricated number
  8. S3 two browser sessions see the same history (the shared pool)
  9. S4 stop/skip from another session is refused (403 DEMO_MODE); the
     starting session's stop controls the replay
 10. S5 the 50-run / 50-model retention: 60 replays + 60 saves on a fresh
     demo server converge to 50 non-pinned runs / 50 non-pinned models
     with the pinned seed run and the pinned example set kept, the oldest
     evicted rows gone (404) and the usage counters true
 11. S6 no sandbox process: the server's child processes are sampled
     throughout (never any), the run rows carry the recorded facts
     (no env download), and the server log after readiness shows no
     sandbox/registry activity

RUN
---
    python3 scripts/demo/e2e-demo.py                        # self-boot
    python3 scripts/demo/e2e-demo.py --app-url http://127.0.0.1:3100
    python3 scripts/demo/e2e-demo.py --binary target/debug/txresbench

The report is written to $TXR_WORK_DIR/qa-data/e2e-demo-report.md (default:
~/.cache/txresbench-dev/qa-data/e2e-demo-report.md — DEC-1: outside the
repo, never /tmp) and mirrored on stdout.
"""

import argparse
import csv
import glob
import importlib.util
import json
import os
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import uuid
import urllib.request

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.abspath(os.path.join(_HERE, "..", ".."))

#: The server's ONE route-policy table (the gate reads only this file; the
#: completeness test pins it against the committed OpenAPI spec).
ALLOWLIST_RS = os.path.join(_REPO, "src-app/server/src/modules/demo/allowlist.rs")
#: The shipped OpenAPI spec (the sweep's enumeration source).
OPENAPI_JSON = os.path.join(_REPO, "src-app/ui/openapi/openapi.json")
#: The example assets the recorder/fixture hashes (write-demo-test-bundle's
#: --assets default).
EXAMPLE_ASSETS = os.path.join(_REPO, "data/file-validator/examples")

#: The default work root (the repo's working-file rule: never /tmp).
#: TXR_WORK_DIR overrides it so the scratch dir is the developer's own.
_WORK_ROOT = os.environ.get(
    "TXR_WORK_DIR", os.path.expanduser("~/.cache/txresbench-dev")
)
DEFAULT_WORK = os.path.join(_WORK_ROOT, "demo-e2e")
#: The default report path (DEC-1: outside the repo). TXR_WORK_DIR overrides it.
DEFAULT_REPORT = os.path.join(_WORK_ROOT, "qa-data", "e2e-demo-report.md")
#: The default app URL (attach mode).
DEFAULT_APP_URL = "http://127.0.0.1:3100"
#: The desktop download page the demo config carries (the mode probe's echo).
DOWNLOAD_URL = "https://github.com/tinnlab/txresbench-app/releases"
#: The demo limits the proof asserts (the spec's numbers, the config defaults).
LIMITS = {"history": 50, "models": 50}
#: The app's allowed+adapted surface (31 allowed + 14 adapted rows of the
#: server's route-policy table — a route added without a classification
#: fails the sweep's completeness check AND this pin).
ALLOWED_ADAPTED_COUNT = 45
#: The fixture bundle's one recorded method (write-demo-test-bundle.py's).
METHOD_ID = "kelim"
CONFIG_ID = "pfs_d56_h238"
#: The example-family facts (qa-fixes3 ITEM-3's generator; the API-level pins).
EXAMPLE_DECISION_DAY = 56
EXAMPLE_TRAINING_PATIENTS = 100
EXAMPLE_PREDICT_PATIENTS = 15
#: Minutes before a step is declared a failure.
STEP_TIMEOUT_SECS = 20 * 60
POLL_SECS = 0.5

#: The CPU-cap wrapper (CAP_SH overrides; empty runs uncapped — a
#: deployment host without an ops wrapper).
CAP_SH = os.environ.get("CAP_SH", "")
#: CAP_CPUS is honored but never above 4 (the node's rule).
CAP_CPUS = min(int(os.environ.get("CAP_CPUS", "4") or "4"), 4)

#: The allowlist row pattern: `RouteRow::<class>("METHOD", "/path")`.
_ROW_RE = re.compile(
    r'RouteRow::(?P<class>allowed|adapted|blocked)\("(?P<method>[A-Z]+)",\s*"(?P<path>[^"]+)"\)'
)


class StepFail(RuntimeError):
    pass


class SkipFlow(RuntimeError):
    """A host-condition skip: the endpoint answered contract-shape but the
    capability is not provisioned (this tree's compiled-in pretrained
    catalogue ships zero entries by the owner's publish-pass rule). Reported,
    never counted as a failure."""


# ─────────────────────────────────────────────────────────────────────────────
# The pure policy/spec parsers (unit-tested; the sweep's source of truth)
# ─────────────────────────────────────────────────────────────────────────────

def parse_route_policy(text):
    """The (method, path, class) rows of the server's route-policy table."""
    rows = []
    for m in _ROW_RE.finditer(text):
        rows.append((m.group("method"), m.group("path"), m.group("class")))
    return rows


def spec_operations(spec):
    """The (method, path-with-api-prefix-stripped) pairs of the OpenAPI spec."""
    ops = []
    for path, methods in spec.get("paths", {}).items():
        bare = path[len("/api"):] if path.startswith("/api") else path
        for verb in ("get", "post", "put", "patch", "delete"):
            if verb in methods:
                ops.append((verb.upper(), bare))
    return sorted(ops)


def materialize_path(path, filler="demo-sweep"):
    """Replace each `{param}` segment with one literal filler segment (the
    gate matches `{param}` against exactly one segment, like the router)."""
    return re.sub(r"\{[^}]+\}", filler, path)


def policy_checks():
    """The completeness pair: the allowlist table covers exactly the shipped
    OpenAPI surface, and every row carries one of the three classes. Returns
    (table_rows, spec_ops)."""
    with open(OPENAPI_JSON, encoding="utf-8") as fh:
        spec = json.load(fh)
    with open(ALLOWLIST_RS, encoding="utf-8") as fh:
        table = parse_route_policy(fh.read())
    table_keys = {(m, p) for m, p, _ in table}
    spec_keys = set(spec_operations(spec))
    missing = sorted(spec_keys - table_keys)
    extra = sorted(table_keys - spec_keys)
    assert not missing, f"OpenAPI operations with NO allowlist row (fail-closed): {missing}"
    assert not extra, f"allowlist rows with no OpenAPI operation (a stale row): {extra}"
    classes = {c for _, _, c in table}
    assert classes <= {"allowed", "adapted", "blocked"}, classes
    return table, spec_keys


# ─────────────────────────────────────────────────────────────────────────────
# The bundle reader (the recorded tables the replay must reproduce)
# ─────────────────────────────────────────────────────────────────────────────

def load_manifest(bundle_dir):
    with open(os.path.join(bundle_dir, "manifest.json"), encoding="utf-8") as fh:
        return json.load(fh)


def bundle_table_rows(bundle_dir, table_rel):
    """The (patient_id, probability, note) rows of one recorded prediction
    table, in file order."""
    path = os.path.join(bundle_dir, table_rel)
    with open(path, encoding="utf-8", newline="") as fh:
        rd = csv.DictReader(fh)
        rows = [(r["patient_id"].strip(), float(r["probability"]), r.get("note", "")) for r in rd]
    return rows


def bundle_record(manifest, config_id, method_id):
    """The one record of the manifest for (configuration, method)."""
    for method in manifest.get("methods", []):
        if method.get("method_id") != method_id:
            continue
        for record in method.get("records", []):
            if record.get("configuration_id") == config_id:
                return record
    raise StepFail(f"no bundle record for {method_id} @ {config_id}")


def predictions_rows(pred_json):
    """The (patient_id, probability) pairs of ONE method column, in order."""
    patients = [p for p in pred_json.get("patients", [])]
    col = pred_json["methods"][0]
    probs = col.get("probabilities", [])
    return [(patients[i], float(probs[i])) for i in range(min(len(patients), len(probs)))]


def assert_rows_equal(what, bundle_rows, got_rows):
    assert len(got_rows) == len(bundle_rows), (
        f"{what}: {len(got_rows)} rows vs the bundle's {len(bundle_rows)}"
    )
    for i, ((pid, prob, note), (gpid, gprob)) in enumerate(zip(bundle_rows, got_rows)):
        assert gpid == pid, f"{what} row {i}: patient {gpid} != recorded {pid}"
        assert abs(gprob - prob) < 1e-9, (
            f"{what} row {i} ({pid}): probability {gprob} != recorded {prob}"
        )


# ─────────────────────────────────────────────────────────────────────────────
# HTTP (the transport seam: `_http` is what the unit test scripts)
# ─────────────────────────────────────────────────────────────────────────────

class StepFailHTTP(StepFail):
    pass


def request(app, method, path, body=None, token=None, cookie=None, timeout=120):
    """One HTTP call: returns (status, parsed-body-or-bytes). Never raises on
    an HTTP error status — the sweep needs to SEE the 403s."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(app + "/api" + path, data=data, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if token is not None:
        req.add_header("Authorization", "Bearer " + token)
    if cookie is not None:
        req.add_header("Cookie", cookie)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            ctype = resp.headers.get("content-type", "")
            if "json" in ctype:
                return resp.status, json.loads(raw)
            return resp.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read()
        ctype = e.headers.get("content-type", "")
        try:
            body = json.loads(raw) if "json" in ctype else raw
        except (json.JSONDecodeError, UnicodeDecodeError):
            body = raw
        return e.code, body
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise StepFailHTTP(f"{method} {path} -> {e}")


def http(app, method, path, body=None, token=None, cookie=None, ok=(200, 201, 202, 204)):
    """One HTTP call that must answer in the `ok` set; raises with the body."""
    status, out = request(app, method, path, body, token, cookie)
    if status not in ok:
        detail = json.dumps(out)[:500] if isinstance(out, (dict, list)) else str(out)[:500]
        raise StepFail(f"{method} {path} -> {status}: {detail}")
    return status, out


#: The transport seams (the unit test replaces these two attributes): `_raw`
#: returns (status, body) for ANY status (the sweep and the refusal checks
#: need to SEE the 403s), `_http` asserts the status.
_raw = request
_http = http


def table_from_csv_text(text, name):
    """The app's table JSON from CSV text (the example endpoint's body)."""
    rd = csv.reader(text.splitlines())
    columns = next(rd)
    rows = [[c if c != "" else None for c in row] for row in rd]
    return {
        "columns": columns,
        "header_row": 1,
        "rows": rows,
        "source": {"format": "csv", "name": name},
    }


def example_table(app, token, kind):
    """One example table through the same endpoint the UI's Use-example flow
    calls: GET /api/file-validation/examples/{kind} -> the CSV text."""
    st, raw = _http(app, "GET", f"/file-validation/examples/{kind}", token=token)
    assert st // 100 == 2, raw
    return table_from_csv_text(raw.decode("utf-8"), f"{kind}-example.csv")


def inspect_table(app, token, kind, table):
    st, ins = _http(
        app, "POST", "/file-validation/inspect", {"kind": kind, "table": table}, token
    )
    assert st // 100 == 2, ins
    errs = [p for p in ins.get("problems", []) if p.get("severity") == "error"]
    assert not errs, f"{kind}: {errs}"
    return ins


def example_validate(app, token, mode, measurements, patients=None):
    st, body = _http(
        app,
        "POST",
        "/file-validation/validate",
        {
            "mode": mode,
            "patients": patients,
            "measurements": measurements,
            "joins": [],
            "mapping": [],
            "parameters": {"decision_day": EXAMPLE_DECISION_DAY, "baseline_max_day": 0},
        },
        token,
    )
    assert st // 100 == 2, body
    assert not [p for p in body.get("problems", []) if p.get("severity") == "error"], body
    return body


def marker_keys(validation):
    return sorted(m.get("key", "").lower() for m in validation.get("markers", []))


def follow_run(app, token, run_id, timeout_secs=STEP_TIMEOUT_SECS):
    """Poll one run's detail until terminal; returns (detail, states_seen)."""
    deadline = time.time() + timeout_secs
    states = []
    while time.time() < deadline:
        _, detail = _http(app, "GET", f"/txr/runs/{run_id}", token=token)
        state = detail.get("status")
        if state not in states:
            states.append(state)
        if state in ("finished", "failed", "stopped"):
            return detail, states
        time.sleep(POLL_SECS)
    raise StepFail(f"run {run_id} did not reach a terminal state within {timeout_secs}s")


def train_run_request(patients, measurements, method_ids, config=None):
    cfg = config or {
        "endpoint": "pfs",
        "decision_day": float(EXAMPLE_DECISION_DAY),
        "look_ahead_day": 238.0,
        "covariates": False,
        "at_a_time": 2,
        "cpus": None,
        "save_models": False,
        "label_day": None,
    }
    return {
        "mode": "train",
        "input": {
            "patients": patients,
            "measurements": measurements,
            "predict_measurements": None,
            "joins": [],
            "mapping": [],
            "keep_copies": True,
        },
        "config": cfg,
        "method_ids": method_ids,
    }


def mint_session(app):
    """POST /session/local — the anonymous demo visitor. Returns
    (access_token, cookie-value) for the SAME browser."""
    req = urllib.request.Request(
        app + "/api/session/local",
        data=json.dumps({}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = json.loads(resp.read())
            cookie = None
            for value in resp.headers.get_all("Set-Cookie") or []:
                if value.startswith("txr_demo_session="):
                    cookie = value.split(";", 1)[0]
                    break
                if cookie is None:
                    cookie = value.split(";", 1)[0]
    except urllib.error.HTTPError as e:
        raise StepFailHTTP(f"POST /session/local -> {e.code}: {e.read().decode()[:300]}")
    assert cookie, "the demo mint sets the anonymous session cookie"
    return body.get("access_token"), cookie


# ─────────────────────────────────────────────────────────────────────────────
# The server lifecycle (self-boot mode; the unit test scripts these too)
# ─────────────────────────────────────────────────────────────────────────────

def free_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def find_binary(explicit=None):
    if explicit:
        if not os.path.isfile(explicit):
            raise StepFailHTTP(f"the binary {explicit} does not exist")
        return explicit
    candidates = [
        os.path.join(os.environ.get("CARGO_TARGET_DIR", ""), "debug", "txresbench"),
        os.path.join(_REPO, "target", "debug", "txresbench"),
    ]
    for cand in candidates:
        if os.path.isfile(cand):
            return cand
    raise StepFailHTTP(
        "no txresbench binary found — build it first (cargo build -p txresbench) "
        "or pass --binary PATH"
    )


def write_server_config(data_dir, bundle_dir, port, replay_speed, download_url):
    cfg = os.path.join(data_dir, "server", "demo.yaml")
    os.makedirs(os.path.dirname(cfg), exist_ok=True)
    with open(cfg, "w", encoding="utf-8") as fh:
        fh.write(
            "server:\n"
            "  host: \"127.0.0.1\"\n"
            f"  port: {port}\n"
            "  api_prefix: \"/api\"\n"
            "  trust_forwarded_headers: true\n"
            "logging:\n"
            "  level: \"info\"\n"
            "  format: \"pretty\"\n"
            "jwt:\n"
            "  secret: \"0123456789abcdef0123456789abcdef-e2e-demo\"\n"
            "  issuer: \"txresbench\"\n"
            "  audience: \"txresbench-api\"\n"
            "  access_token_expiry_hours: 24\n"
            "  refresh_token_expiry_days: 30\n"
            "database:\n"
            f"  path: \"{data_dir}/txresbench.db\"\n"
            "demo:\n"
            "  enabled: true\n"
            f"  download_url: \"{download_url}\"\n"
            "  history_limit: 50\n"
            "  model_limit: 50\n"
            "  max_bytes: 8388608\n"
            f"  replay_speed: {replay_speed}\n"
            "  notice: \"demo_banner\"\n"
            f"  bundle_path: \"{bundle_dir}\"\n"
        )
    return cfg


class Server:
    """One spawned demo server: the log (parsed for the ready line + scanned
    for sandbox activity) and the child-process sampler."""

    READY_RE = re.compile(r"TxResBench listening on http://(\S+)/api")

    def __init__(self, work_dir, bundle_dir, replay_speed, download_url, binary):
        self.work_dir = work_dir
        self.data_dir = os.path.join(work_dir, "data")
        self.bundle = bundle_dir
        self.config = write_server_config(
            self.data_dir, bundle_dir, 0, replay_speed, download_url
        )
        self.binary = binary
        self.log_path = os.path.join(work_dir, "server.log")
        self.log = open(self.log_path, "w", encoding="utf-8")
        self.proc = None
        self.url = None
        self.pid = None
        self._sampler = None
        self._children_seen = []

    def boot(self, ready_timeout=180):
        env = os.environ.copy()
        env["TXR_APP_DATA_DIR"] = self.data_dir
        env["TXR_DEMO_BUNDLE"] = self.bundle
        env["CAP_CPUS"] = str(CAP_CPUS)
        cmd = ([CAP_SH] if CAP_SH else []) + [
            self.binary, "--config-file", self.config, "--demo"
        ]
        self.proc = subprocess.Popen(
            cmd, stdout=self.log, stderr=subprocess.STDOUT, env=env, cwd=self.work_dir
        )
        self.pid = self.proc.pid
        deadline = time.time() + ready_timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise StepFailHTTP(
                    f"the demo server exited at boot ({self.proc.returncode}) — see {self.log_path}"
                )
            with open(self.log_path, encoding="utf-8", errors="replace") as fh:
                text = fh.read()
            m = self.READY_RE.search(text)
            if m:
                self.url = "http://" + m.group(1)
                return self
            time.sleep(0.25)
        raise StepFailHTTP(f"the demo server did not report ready — see {self.log_path}")

    def start_sample(self):
        self._sampler = threading.Thread(target=self._sample, daemon=True)
        self._sampler.start()

    def _sample(self):
        while self.proc.poll() is None:
            children = self._children()
            if children:
                self._children_seen.append(children)
            time.sleep(0.3)

    def _children(self):
        seen = []
        for task in sorted(glob.glob(f"/proc/{self.pid}/task/*")):
            try:
                with open(os.path.join(task, "children"), encoding="utf-8") as fh:
                    for line in fh:
                        seen.extend(line.split())
            except OSError:
                continue
        return seen

    def children_seen(self):
        return [c for c in self._children_seen or [] if c]

    def stop(self):
        if self.proc is None or self.proc.poll() is not None:
            return
        self.proc.terminate()
        try:
            self.proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=30)
        self.log.close()

    def advance_log(self):
        """The server log AFTER the ready line (the sandbox-activity scan's
        window: boot probes are allowed, anything later is activity)."""
        with open(self.log_path, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
        i = text.find("TxResBench listening on")
        return text[i:] if i >= 0 else text

    def sandbox_activity(self):
        """Lines after readiness that mention the sandbox/registry stack."""
        markers = ("bwrap", "oras", "cosign", "method env", "method-env",
                   "manifest", "registry", "squashfuse", "sandbox:")
        bad = []
        for line in self.advance_log().splitlines():
            if not any(m in line.lower() for m in markers):
                continue
            low = line.lower()
            if "sandbox: stack =" in low or "sandbox: registered" in low:
                continue
            bad.append(line)
        return bad


class FixtureServer(Server):
    """The self-boot server with a fixture bundle (the writer's minimal
    valid recorded bundle over the REAL example assets)."""

    def __init__(self, work_dir, assets_dir, replay_speed, download_url, binary):
        self.assets_dir = assets_dir
        self.bundle = os.path.join(work_dir, "bundle")
        super().__init__(work_dir, self.bundle, replay_speed, download_url, binary)

    def write_bundle(self):
        cmd = [
            sys.executable,
            os.path.join(_HERE, "write-demo-test-bundle.py"),
            "--assets", self.assets_dir,
            "--out", self.bundle,
        ]
        subprocess.run(cmd, check=True)
        return self.bundle


# ─────────────────────────────────────────────────────────────────────────────
# ─────────────────────────────────────────────────────────────────────────────

def step_mode(app):
    st, body = _http(app, "GET", "/app/mode")
    assert st == 200, body
    assert body["mode"] == "demo", body
    assert body["limits"]["history"] == LIMITS["history"], body
    assert body["limits"]["models"] == LIMITS["models"], body
    return f"mode {body['mode']}, limits {body['limits']}, download_url {body['download_url']}"


def step_sweep(app):
    """S1: every OpenAPI operation outside the allowlist answers 403 with the
    DEMO_MODE bytes. The policy table is parsed from the server's own
    allowlist.rs and its completeness against the committed spec re-asserted
    here, so a route without a row fails this step before a single request."""
    table, spec_keys = policy_checks()
    blocked = sorted(
        (m, materialize_path(p)) for m, p, c in table if c == "blocked"
    )
    assert len(blocked) == len(spec_keys) - ALLOWED_ADAPTED_COUNT, (
        f"{len(blocked)} blocked rows vs {len(spec_keys)} spec operations "
        f"({ALLOWED_ADAPTED_COUNT} allowed/adapted expected)"
    )
    for method, path in blocked:
        st, body = _raw(app, method, path)
        assert st == 403, f"{method} {path} -> {st} (expected 403 DEMO_MODE)"
        assert isinstance(body, dict) and body.get("error_code") == "DEMO_MODE", (
            f"{method} {path} -> {body}"
        )
        assert body.get("error") == "This is not available in the demo", body
    return f"{len(blocked)} blocked operations all answered 403 DEMO_MODE"


def step_upload_refusal(app, token):
    """S2: an upload attempt fails — inspect + validate with a table that is
    not the example answer 403 DEMO_MODE (the bundle-hash guard)."""
    fake = {
        "columns": ["patient_id", "pfs_days", "pfs_event"],
        "header_row": 1,
        "rows": [["X0000", "100", "1"]],
        "source": {"format": "csv", "name": "not-the-example.csv"},
    }
    st, body = _raw(app, "POST", "/file-validation/inspect",
                    {"kind": "patients", "table": fake}, token)
    assert st == 403 and body.get("error_code") == "DEMO_MODE", (st, body)
    st, body = _raw(
        app, "POST", "/file-validation/validate",
        {
            "mode": "files",
            "patients": fake,
            "measurements": fake,
            "joins": [],
            "mapping": [],
            "parameters": {"decision_day": EXAMPLE_DECISION_DAY, "baseline_max_day": 0},
        },
        token,
    )
    assert st == 403 and body.get("error_code") == "DEMO_MODE", (st, body)
    return "inspect + validate with a non-example table both answered 403 DEMO_MODE"


def step_train_path(ctx, patients, measurements):
    """P1: the train path — the replay run equals the bundle's recorded train
    results; save models produces the generated name."""
    app, token, cookie = ctx.app, ctx.token_a, ctx.cookie_a
    keys = marker_keys(ctx.validation)
    assert keys == ["m1", "m2", "m3"], keys
    assert ctx.validation["patients"]["rows"] == EXAMPLE_TRAINING_PATIENTS, ctx.validation

    # Eligibility + estimate are answered from the bundle (recorded methods
    # can_run, recorded seconds / replay_speed).
    st, elig = _http(app, "POST", "/methods/eligibility",
                     {"inventory": ctx.validation["inventory"]}, token)
    assert st // 100 == 2, elig
    kelim = next(m for m in elig["methods"] if m["id"] == METHOD_ID)
    assert kelim["status"] == "can_run", kelim
    assert kelim["estimated_seconds"] == 15.0, kelim

    st, est = _http(app, "POST", "/methods/estimate",
                    {"method_ids": [METHOD_ID],
                     "patients": EXAMPLE_TRAINING_PATIENTS,
                     "at_a_time": 2}, token)
    assert st // 100 == 2, est
    assert est["methods"][0]["estimated_seconds"] == 15.0, est
    assert est["methods"][0]["estimate_quality"] == "measured", est

    # The replay run: preparing -> running -> finished with the cloned rows.
    st, created = _http(
        app, "POST", "/txr/runs",
        train_run_request(patients, measurements, [METHOD_ID]), token, cookie=cookie,
    )
    assert st == 202, created
    ctx.run_id = created["id"]
    assert created["status"] == "preparing", created
    detail, states = follow_run(app, token, ctx.run_id)
    assert detail["status"] == "finished", detail
    assert "running" in states, states
    method = detail["methods"][0]
    assert method["state"] == "finished", method
    assert method["prob_source"] == "native", method
    ctx.method = method
    record_facts = bundle_record(ctx.manifest, CONFIG_ID, METHOD_ID)
    assert method["coverage"]["scored"] == len(
        bundle_table_rows(ctx.bundle_dir, record_facts["train"]["table"])
    ), method
    # The recorded facts, not a real run: no env bytes, the flooring elapsed.
    assert method.get("bytes_total") is None, method
    assert method["elapsed_secs"] >= 1, method

    # The predictions JSON + CSV equal the bundle's recorded train table.
    st, pred = _http(app, "GET", f"/txr/runs/{ctx.run_id}/predictions", token=token)
    assert st // 100 == 2, pred
    st, csv_bytes = _raw(app, "GET", f"/txr/runs/{ctx.run_id}/predictions.csv", token=token)
    assert st == 200, csv_bytes
    assert csv_bytes.startswith(b"patient_id,"), csv_bytes
    expected = bundle_table_rows(ctx.bundle_dir, record_facts["train"]["table"])
    assert_rows_equal("train predictions", expected, predictions_rows(pred))
    assert len(pred["patients"]) + 1 == len(csv_bytes.decode("utf-8").splitlines()), (
        "the CSV carries one row per patient"
    )

    # Save models: the generated name, no visitor text, no export.
    st, saved = _http(
        app, "POST", "/txr/models/save",
        {
            "run_id": ctx.run_id,
            "method_ids": [METHOD_ID],
            "target": {"set_name": "visitor-chosen name"},
            "keep_training_files": False,
            "also_export": True,
        },
        token,
    )
    assert st in (200, 201), saved
    assert saved["set"]["name"].startswith("Demo models "), saved
    assert saved.get("export") is None, saved
    ctx.model_id = saved["models"][0]["id"]
    assert saved["models"][0]["method_id"] == METHOD_ID, saved
    st, sets = _http(app, "GET", "/txr/model-sets", token=token)
    assert st // 100 == 2 and any(s["id"] == saved["set"]["id"] for s in sets["sets"]), sets
    ctx.set_id = saved["set"]["id"]
    return f"run {ctx.run_id}: preparing->running->finished, predictions + CSV equal the bundle, saved as '{saved['set']['name']}'"


def step_reuse_path(ctx):
    """P2: the reuse path — the seeded example set (pinned) + a replay reuse
    run whose predictions equal the bundle's reuse table."""
    app, token, cookie = ctx.app, ctx.token_a, ctx.cookie_a
    st, example = _http(app, "POST", "/txr/models/example", {}, token)
    assert st // 100 == 2, example
    assert example["state"] == "ready", example
    assert example.get("set_id"), example
    st, models = _http(app, "GET", f"/txr/models?set_id={example['set_id']}", token=token)
    assert st // 100 == 2 and models["models"], models
    st, resolved = _http(app, "POST", "/txr/models/resolve",
                         {"model_ids": [m["id"] for m in models["models"]]}, token)
    assert st // 100 == 2 and resolved["assets"], resolved
    predict = example_table(app, token, "predict-measurements")
    ids = sorted({row[0] for row in predict["rows"]})
    assert len(ids) == EXAMPLE_PREDICT_PATIENTS, ids
    st, reuse = _http(
        app, "POST", "/txr/runs",
        {
            "mode": "reuse",
            "input": {
                "patients": None,
                "measurements": predict,
                "predict_measurements": predict,
                "joins": [],
                "mapping": [],
                "keep_copies": True,
            },
            "config": {
                "endpoint": "pfs",
                "decision_day": float(EXAMPLE_DECISION_DAY),
                "look_ahead_day": 238.0,
                "covariates": False,
                "at_a_time": 2,
                "cpus": None,
                "save_models": False,
                "label_day": None,
            },
            "model_ids": resolved["assets"],
        },
        token, cookie=cookie,
    )
    assert st == 202, reuse
    reuse_id = reuse["id"]
    done, _states = follow_run(app, token, reuse_id)
    assert done["status"] == "finished", done
    st, pred = _http(app, "GET", f"/txr/runs/{reuse_id}/predictions", token=token)
    assert st // 100 == 2, pred
    expected = bundle_table_rows(
        ctx.bundle_dir,
        bundle_record(ctx.manifest, CONFIG_ID, METHOD_ID)["reuse"]["table"],
    )
    assert_rows_equal("reuse predictions", expected, predictions_rows(pred))
    return f"example set {example['set_id']} (ready, pinned) -> reuse run {reuse_id} -> predictions equal the bundle"


def step_pretrained_path(ctx):
    """P3: the pretrained path — the catalogue + eligibility. A deployment
    whose compiled-in catalogue ships zero entries answers the honest
    no-cards state (this tree's publish-pass rule) and this is the SKIP."""
    st, body = _http(ctx.app, "GET", "/txr/pretrained", token=ctx.token_a)
    assert st // 100 == 2, body
    models = body.get("models", [])
    if not models:
        raise SkipFlow(
            "this app serves no pretrained catalogue — the no-cards state of this tree "
            "(the publish-pass rule); the demo arm is the run-from-recorded-facts one"
        )
    st, verdicts = _http(
        ctx.app, "POST", "/txr/pretrained/eligibility",
        {"model_ids": [m["id"] for m in models],
         "inventory": ctx.validation["inventory"]},
        ctx.token_a,
    )
    assert st // 100 == 2, verdicts
    assert len(verdicts["models"]) == len(models), verdicts
    assert all(v.get("status") in ("can_run", "can_run_some", "cannot_run")
               for v in verdicts["models"]), verdicts
    return f"{len(models)} catalogue entries, verdicts contract-shaped"


def step_shared_pool(ctx):
    """S3: two browser sessions see the same shared-history pool."""
    st, runs_a = _http(ctx.app, "GET", "/txr/runs", token=ctx.token_a)
    assert st // 100 == 2
    st, runs_b = _http(ctx.app, "GET", "/txr/runs", token=ctx.token_b, cookie=ctx.cookie_b)
    assert st // 100 == 2 and runs_a["runs"] == runs_b["runs"], (
        "session A and B read the same runs"
    )
    ids = [r["id"] for r in runs_a["runs"]]
    assert ctx.run_id in ids, f"session B sees the run {ctx.run_id}: {ids}"
    st, models_a = _http(ctx.app, "GET", "/txr/models", token=ctx.token_a)
    assert st // 100 == 2
    st, models_b = _http(ctx.app, "GET", "/txr/models", token=ctx.token_b, cookie=ctx.cookie_b)
    assert st // 100 == 2 and models_a == models_b, "session A and B read the same models"
    if ctx.set_id:
        ids = [m.get("set_id") for m in models_a["models"]]
        assert ctx.set_id in ids, ids
    return "two sessions read the identical runs and models lists"


def step_stop_ownership(ctx):
    """S4: stop/skip from another session is refused (403 DEMO_MODE); the
    starting session's stop controls the replay."""
    app, token_a, cookie_a = ctx.app, ctx.token_a, ctx.cookie_a
    st, created = _http(
        app, "POST", "/txr/runs",
        train_run_request(ctx.patients, ctx.measurements, [METHOD_ID]),
        token_a, cookie=cookie_a,
    )
    assert st == 202, created
    run_id = created["id"]
    deadline = time.time() + 60
    detail = None
    while time.time() < deadline:
        _, detail = _http(app, "GET", f"/txr/runs/{run_id}", token=token_a)
        if detail["methods"][0]["state"] == "running":
            break
        time.sleep(POLL_SECS)
    if detail is None or detail["methods"][0]["state"] != "running":
        raise StepFailHTTP(f"the replay never turned running: {detail}")

    for control in (f"/txr/runs/{run_id}/stop",
                    f"/txr/runs/{run_id}/methods/{METHOD_ID}/skip"):
        st, body = _raw(app, "POST", control, {}, ctx.token_b, cookie=ctx.cookie_b)
        assert st == 403 and body.get("error_code") == "DEMO_MODE", (control, st, body)
    st, _ = _raw(app, "POST", f"/txr/runs/{run_id}/stop", {}, token_a, cookie=cookie_a)
    assert st == 202, "the starting session may stop its run"
    done, _ = follow_run(app, token_a, run_id)
    assert done["status"] == "stopped", done
    assert done["methods"][0]["state"] == "stopped", done
    return "foreign stop/skip = 403 DEMO_MODE; the starting session's stop won"


def plant_backdated_sets(db_path, count=60):
    """Clone the newest non-pinned set + its models into `count` sets that are
    OLDER than it (the repository seam the demo's retention test uses — the
    API creates one set per minute because the generated name is
    minute-precision, so 60 same-minute saves are not the API's shape; the
    planted rows share the saved set's content-addressed tree, which the
    refcount prune protects). Returns the planted set ids."""
    con = sqlite3.connect(db_path, timeout=60)
    con.execute("PRAGMA busy_timeout=60000")
    try:
        cur = con.execute(
            "SELECT * FROM txr_model_sets ORDER BY created_at DESC LIMIT 1"
        )
        set_row = cur.fetchone()
        if set_row is None:
            raise StepFailHTTP("no saved set found to plant from")
        set_cols = [d[0] for d in cur.description]
        cur2 = con.execute("SELECT * FROM txr_models WHERE set_id = ?",
                           (set_row[set_cols.index("id")],))
        models = cur2.fetchall()
        model_cols = [d[0] for d in cur2.description]
        if not models:
            raise StepFailHTTP("the saved set carries no model rows to plant")

        def fresh_id(like):
            if isinstance(like, (bytes, bytearray)):
                return uuid.uuid4().bytes
            return str(uuid.uuid4())

        planted = []
        for i in range(count):
            row_id = fresh_id(set_row[set_cols.index("id")])
            name = f"Planted demo set {i}"
            set_values = list(set_row)
            set_values[set_cols.index("id")] = row_id
            set_values[set_cols.index("name")] = name
            set_values[set_cols.index("created_at")] = (
                f"2000-01-01T00:00:{i:02d}.000Z"
            )
            ph = ", ".join("?" * len(set_cols))
            col_sql = ", ".join(f'"{c}"' for c in set_cols)
            con.execute(
                f"INSERT INTO txr_model_sets ({col_sql}) VALUES ({ph})",
                set_values,
            )
            for model in models:
                model_values = list(model)
                model_values[model_cols.index("id")] = fresh_id(
                    model[model_cols.index("id")]
                )
                model_values[model_cols.index("set_id")] = set_values[
                    set_cols.index("id")
                ]
                ph = ", ".join("?" * len(model_cols))
                col_sql = ", ".join(f'"{c}"' for c in model_cols)
                con.execute(
                    f"INSERT INTO txr_models ({col_sql}) VALUES ({ph})",
                    model_values,
                )
            if isinstance(row_id, (bytes, bytearray)):
                planted.append(str(uuid.UUID(bytes=bytes(row_id))))
            else:
                planted.append(str(row_id))
        con.commit()
        return planted
    finally:
        con.close()


def step_retention(ctx):
    """S5: the 50-run / 50-model retention with the pinned entries kept.
    The run half is the API's own: 60 replays (sequential — one active run at
    a time) then a trigger. The model half saves ONE set through the API (the
    generated name is minute-precision, so the API creates one set per
    minute), plants 60 older sets at the repository seam the node's retention
    test uses, and lets the same enforcement pass settle both limits."""
    app, token, cookie = ctx.app, ctx.token_a, ctx.cookie_a
    st, example = _http(app, "POST", "/txr/models/example", {}, token)
    assert st // 100 == 2 and example["state"] == "ready", example
    example_set_id = example["set_id"]

    # The 60 sequential replays + the one API save (from the newest run).
    created = []
    for i in range(60):
        st, run = _http(
            app, "POST", "/txr/runs",
            train_run_request(ctx.patients, ctx.measurements, [METHOD_ID]),
            token, cookie=cookie,
        )
        assert st == 202, f"create run {i}: {run}"
        created.append(run["id"])
        done, _ = follow_run(app, token, run["id"], timeout_secs=180)
        assert done["status"] == "finished", f"run {i}: {done['status']}"

    st, saved = _http(
        app, "POST", "/txr/models/save",
        {
            "run_id": created[-1],
            "method_ids": [METHOD_ID],
            "target": {"set_name": "retention visitor"},
            "keep_training_files": False,
            "also_export": False,
        },
        token,
    )
    assert st in (200, 201), saved
    saved_set_id = saved["set"]["id"]
    assert saved["set"]["name"].startswith("Demo models "), saved
    planted = plant_backdated_sets(ctx.db_path)

    # The trigger run: the next create's detached pass sees 61 runs and 61
    # non-pinned sets and evicts the oldest 11 of each (the limit is 50).
    st, trig = _http(
        app, "POST", "/txr/runs",
        train_run_request(ctx.patients, ctx.measurements, [METHOD_ID]),
        token, cookie=cookie,
    )
    assert st == 202, trig
    done, _ = follow_run(app, token, trig["id"], timeout_secs=180)
    assert done["status"] == "finished", done

    deadline = time.time() + 180
    usage = None
    while time.time() < deadline:
        st, usage = _http(app, "GET", "/txr/history/usage", token=token)
        assert st // 100 == 2, usage
        if usage["runs"] == LIMITS["history"] and usage["models"] == LIMITS["models"]:
            break
        time.sleep(0.5)
    else:
        raise StepFailHTTP(f"the retention did not settle: {usage}")

    assert usage["run_limit"] == LIMITS["history"], usage
    assert usage["model_limit"] == LIMITS["models"], usage
    assert usage["pinned_runs"] >= 1, usage
    assert usage["pinned_models"] >= 1, usage
    assert usage["shared"] is True, usage

    # Runs: the newest 50 non-pinned + the pinned seed; the 11 oldest evicted.
    st, runs = _http(app, "GET", "/txr/runs", token=token)
    assert runs["total"] == LIMITS["history"] + 1, runs
    ids = [r["id"] for r in runs["runs"]]
    assert trig["id"] in ids and created[-1] in ids, "the newest runs stay"
    for i in (0, 10):
        st, _ = _raw(app, "GET", f"/txr/runs/{created[i]}", token=token)
        assert st == 404, f"run {i} was evicted: {st}"
    for i in (11, 59):
        st, _ = _raw(app, "GET", f"/txr/runs/{created[i]}", token=token)
        assert st == 200, f"run {i} stays: {st}"

    # Model sets: 50 non-pinned + the pinned example set; the newest saved
    # set stays, the oldest 11 planted are gone, the example set is whole.
    st, sets = _http(app, "GET", "/txr/model-sets", token=token)
    assert len(sets["sets"]) == LIMITS["models"] + 1, sets
    ids = [s["id"] for s in sets["sets"]]
    assert saved_set_id in ids, "the newest saved set stays"
    assert example_set_id in ids, "the pinned example set stays"
    assert not any(p in ids for p in planted[:11]), "the 11 oldest planted are evicted"
    assert all(p in ids for p in planted[11:]), "the newer planted stay"
    st, example_models = _http(app, "GET", f"/txr/models?set_id={example_set_id}", token=token)
    assert st // 100 == 2 and len(example_models["models"]) == 1, example_models
    return (f"{LIMITS['history']} runs / {LIMITS['models']} model rows kept — the pinned seed "
            f"run + the pinned example set alive, the 11 oldest runs and sets evicted (404)")


def step_no_sandbox(server, run_method=None):
    """S6: no sandbox process was started — the server's children are
    sampled throughout (never any), no sandbox/registry activity appears in
    the log after readiness, and the run rows carry the recorded facts
    (no environment download)."""
    problems = []
    seen = server.children_seen()
    if seen:
        problems.append(f"the demo server spawned child processes during the drive: {seen}")
    activity = server.sandbox_activity()
    if activity:
        problems.append(f"sandbox/registry activity in the server log: {activity[:5]}")
    if run_method is not None:
        if run_method.get("bytes_total") is not None:
            problems.append(f"the run row carried env bytes: {run_method.get('bytes_total')}")
        if run_method.get("elapsed_secs", 0) < 1:
            problems.append("the run row did not carry the replay's floor elapsed")
        if run_method.get("prob_source") != "native":
            problems.append("the run row's prob_source is not the recorded one")
    if problems:
        raise StepFailHTTP("; ".join(problems))
    return ("no child process ever; no sandbox/registry log lines after readiness; "
            "the run rows carry the recorded facts")


def write_report(path, lines, ok):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("# e2e-demo report\n\n")
        for line in lines:
            fh.write(line + "\n")
        fh.write("\nVERDICT: " + ("PASS" if ok else "FAIL") + "\n")
    return path


# ─────────────────────────────────────────────────────────────────────────────
# The drive: one step function per numbered check, sharing a context
# ─────────────────────────────────────────────────────────────────────────────

class Walk:
    """The shared context of one server's drive (sessions, examples, ids)."""

    def __init__(self, app, manifest=None, bundle_dir=None):
        self.app = app
        self.manifest = manifest
        self.bundle_dir = bundle_dir
        self.token_a = self.cookie_a = self.token_b = self.cookie_b = None
        self.patients = self.measurements = self.validation = None
        self.run_id = self.model_id = self.set_id = self.method = None
        self.db_path = None

    def mint(self):
        self.token_a, self.cookie_a = mint_session(self.app)
        self.token_b, self.cookie_b = mint_session(self.app)
        return self

    def load_examples(self):
        self.patients = example_table(self.app, self.token_a, "patients")
        self.measurements = example_table(self.app, self.token_a, "measurements")
        inspect_table(self.app, self.token_a, "patients", self.patients)
        inspect_table(self.app, self.token_a, "measurements", self.measurements)
        self.validation = example_validate(
            self.app, self.token_a, "files", self.measurements, self.patients
        )
        return self


def drive(ctx):
    """The six checks of one demo server (the plan's bullets), as lazy
    (name, fn) pairs so one failure never discards the others' records. The
    pretrained path is its own step — the empty catalogue is the honest
    SKIP, never a failure."""
    ctx.load_examples()
    return [
        ("1 mode probe", lambda: step_mode(ctx.app)),
        ("2 S1 blocked-route sweep", lambda: step_sweep(ctx.app)),
        ("3 S2 an upload attempt fails",
         lambda: step_upload_refusal(ctx.app, ctx.token_a)),
        ("4 P1 recorded train path",
         lambda: step_train_path(ctx, ctx.patients, ctx.measurements)),
        ("5 P2 recorded reuse path", lambda: step_reuse_path(ctx)),
        ("6 P3 pretrained path", lambda: step_pretrained_path(ctx)),
        ("7 S3 two sessions see the same history",
         lambda: step_shared_pool(ctx)),
        ("8 S4 stop/skip from another session is refused",
         lambda: step_stop_ownership(ctx)),
    ]


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="TxResBench demo-mode ITEM-8 deployment proof (TEST-DM-7)"
    )
    ap.add_argument("--app-url", default=None,
                    help="attach to a running demo service (default: boot one)")
    ap.add_argument("--binary", default=None, help="the txresbench binary path")
    ap.add_argument("--bundle", default=None,
                    help="the recorded bundle dir (attach mode; self-boot writes a fixture)")
    ap.add_argument("--assets", default=EXAMPLE_ASSETS,
                    help="the example assets dir the fixture bundle hashes")
    ap.add_argument("--work-dir", default=DEFAULT_WORK,
                    help="scratch root (data dirs, logs; never /tmp)")
    ap.add_argument("--report", default=DEFAULT_REPORT,
                    help="the report file (outside the repo)")
    ap.add_argument("--download-url", default=DOWNLOAD_URL,
                    help="the download_url the demo config carries")
    ap.add_argument("--replay-speed", type=float, default=10.0,
                    help="the path server's replay speed (recorded 150 s / 10 = 15 s)")
    ap.add_argument("--retention-replay-speed", type=float, default=150.0,
                    help="the retention server's replay speed (the 1.5 s floor)")
    ap.add_argument("--keep", action="store_true",
                    help="keep the work dirs (default: deleted after the run)")
    args = ap.parse_args(argv)

    lines = []
    dirs = []
    ok = False

    def record(name, fn):
        nonlocal ok
        try:
            line = fn()
            lines.append(f"PASS  {name}: {line}")
        except SkipFlow as e:
            lines.append(f"SKIP  {name}: {e}")
        except Exception as e:
            lines.append(f"FAIL  {name}: {e}")
            ok = False
        return

    try:
        table, spec_keys = policy_checks()
        lines.insert(
            0,
            f"policy: {len(table)} allowlist rows, {len(spec_keys)} OpenAPI operations — completeness holds",
        )
        ok = True

        if args.app_url:
            # ── attach mode: the running deployment (read/flow proof only) ──
            ctx = Walk(args.app_url.rstrip("/"))
            ctx.mint()
            for name, fn in drive(ctx):
                record(name, fn)
            lines.append(
                "SKIP  S5 50/50 retention: attach mode (it is a load test for an "
                "ephemeral server — run without --app-url)"
            )
            lines.append(
                "SKIP  S6 no sandbox process: attach mode (the server is not this "
                "script's child)"
            )
        else:
            # ── self-boot mode: the fixture server, then the retention server ──
            binary = find_binary(args.binary)
            os.makedirs(args.work_dir, exist_ok=True)
            work = tempfile.mkdtemp(prefix="e2e-demo-", dir=args.work_dir)
            dirs.append(work)
            server = FixtureServer(work, args.assets, args.replay_speed,
                                   args.download_url, binary)
            server.write_bundle()
            server.boot()
            server.start_sample()
            ctx = Walk(server.url, load_manifest(server.bundle), server.bundle)
            ctx.mint()
            runner = None
            try:
                for name, fn in drive(ctx):
                    record(name, fn)
                record("9 S6 no sandbox process (path server)",
                       lambda: step_no_sandbox(server, ctx.method))
            finally:
                server.stop()

            ret_work = tempfile.mkdtemp(prefix="e2e-demo-ret-", dir=args.work_dir)
            dirs.append(ret_work)
            ret = FixtureServer(ret_work, args.assets, args.retention_replay_speed,
                                args.download_url, binary)
            ret.write_bundle()
            ret.boot()
            ret.start_sample()
            try:
                rctx = Walk(ret.url, load_manifest(ret.bundle), ret.bundle)
                rctx.db_path = os.path.join(ret.data_dir, "txresbench.db")
                rctx.mint()
                rctx.patients = example_table(rctx.app, rctx.token_a, "patients")
                rctx.measurements = example_table(rctx.app, rctx.token_a, "measurements")
                record("10 S5 the 50-run / 50-model retention",
                       lambda: step_retention(rctx))
                record("11 S6 no sandbox process (retention server)",
                       lambda: step_no_sandbox(ret))
            finally:
                ret.stop()

        for line in lines:
            print(line)
        print(f"report: {write_report(args.report, lines, ok)}")
        return 0 if ok else 1
    except (Exception,) as e:
        lines.append(f"FAIL  {e}")
        for line in lines:
            print(line)
        write_report(args.report, lines, False)
        return 1
    finally:
        if not args.keep:
            for d in dirs:
                shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
