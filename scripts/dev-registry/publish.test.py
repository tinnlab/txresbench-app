#!/usr/bin/env python3
"""Tests for scripts/dev-registry/publish.py (TEST-QA-2, publisher half).

Unittest, stdlib only, no docker, no oras, no network beyond loopback: an
ITEM-1 registry serves an ephemeral port in-process; the publisher pushes the
FIXTURE artifact family through its real `build_and_publish` path; every
assertion is about the BYTES the app parses:

  * the manifest construction is byte-identical to the pinned §6.1 shape
    (key order, no whitespace, the empty-config literal, the annotation table
    in order, `com.txr.layer_schema` the string "1") — the same literal
    `registry.test.py` pins;
  * the registry stores the exact digest set the app verifies: the OCI
    manifest digest == the dev manifest's `digest`, the layer blob sha256 ==
    the dev manifest's `layer_sha256` == sha256 of the packed squashfs; the
    base blob sha256 == the dev manifest's `base_digest` (the app's
    payload-verify pin);
  * the dev manifest satisfies the app's own structural rules (the
    `envmanifest.rs` validator set mirrored here: schema_version 1,
    env_id == method_id, layer_schema 1,
    tag == <env_id>-<version>-<arch>-<first 12 hex of layer_sha256>,
    pin shapes, oci_ref == the one layer package, base-ref family,
    size >= 1, contract <major>.<minor>, sorted by (env_id, arch));
  * the artifacts sit in the two packages and nowhere else: every layer in
    `tinnlab/txr-method-env-layers` (the method and its layer hash in the
    tag), the base in
    `tinnlab/txresbench-env` at the app's no-`bases` tag
    `base-<family>-<contract>-<arch>`; the old one-package-per-method and
    per-base repos hold nothing;
  * the packed layer contains the §5 contract: /code files,
    `/.txr-method-env-layer-schema` == "1", `/layer-manifest.json` ==
    ["/code"], the root `usr/` mount-readiness sentinel, modes >= 0644/0755;
    `wrapper_code_sha256` == design §2.2's byte concatenation;
  * the `oras_dev` drop-in resolves + pulls the pushed artifacts (the exact
    subcommands the app shells out to) and the pulled bytes match.

The real-method publish (five real layers + both bases) is the heavy
TXR_DEV_TEST_REAL=1 leg, gated so the structural suite stays fast; the
fixture family is the same code path.

Run: python3 scripts/dev-registry/publish.test.py
"""

import hashlib
import http.client
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import publish  # noqa: E402
import registry  # noqa: E402

MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json"
ARTIFACT_MEDIA_TYPE = "application/vnd.txr.method-env.layer.v1"
EMPTY_CONFIG = b"{}"
EMPTY_CONFIG_DIGEST = "sha256:" + hashlib.sha256(EMPTY_CONFIG).hexdigest()


def _pick_tmp_root():
    candidates = [os.environ.get("TMPDIR"),
                  "/data/pbya/txresbench-app-work/tmp-qa-hardening"]
    for candidate in candidates:
        if not candidate:
            continue
        try:
            registry.validate_data_dir(candidate)
        except ValueError:
            continue
        os.makedirs(candidate, exist_ok=True)
        return candidate
    raise SystemExit("publish tests: no usable tmp root (TMPDIR is unusable)")


TEST_TMP_ROOT = _pick_tmp_root()

FIXTURE_METHOD_ID = publish.FIXTURE_METHOD_ID
FIXTURE_BASE_ID = publish.FIXTURE_BASE_ID
#: The two packages and the tags, spelled independently of publish.py.
LAYER_PACKAGE = "tinnlab/txr-method-env-layers"
BASE_PACKAGE = "tinnlab/txresbench-env"
#: The fixture layer's tag is "txr-dev-fixture-1.0.0-amd64-<sha12 of its
#: packed squashfs>" (fixture_tag(), read from the packed file's bytes).
FIXTURE_TAG_PREFIX = "txr-dev-fixture-1.0.0-amd64-"
#: The app's base tag for a manifest without `bases` (base_env_ref).
FIXTURE_BASE_TAG = "base-py-2.0-amd64"


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def artifact_manifest_bytes(layer_sha256_hex, size_bytes, annotations):
    """The §6.1 construction as the app's parser sees it (byte-exact) — an
    INDEPENDENT literal built from the design doc's field order (not a copy of
    publish.py's formatter, so a formatter regression cannot be self-verified)."""
    doc = {
        "schemaVersion": 2,
        "mediaType": MANIFEST_MEDIA_TYPE,
        "artifactType": ARTIFACT_MEDIA_TYPE,
        "config": {
            "mediaType": "application/vnd.oci.empty.v1+json",
            "digest": EMPTY_CONFIG_DIGEST,
            "size": 2,
        },
        "layers": [{
            "mediaType": ARTIFACT_MEDIA_TYPE,
            "digest": "sha256:" + layer_sha256_hex,
            "size": size_bytes,
            "annotations": {"org.opencontainers.image.title": "layer.squashfs"},
        }],
        "annotations": annotations,
    }
    return json.dumps(doc, separators=(",", ":")).encode("utf-8")


def validate_app_manifest(doc):
    """Mirrors src-app/server/src/modules/execution_engine/envmanifest.rs's
    validate_manifest set (the app-boot rules the dev data must pass)."""
    assert doc["schema_version"] == 2, doc
    assert "source_revision" not in doc, "schema 2: the provenance is per entry"
    assert isinstance(doc["base_contract"], str) and "." in doc["base_contract"]
    assert doc["base_contract"].split(".")[0].isdigit() and doc["base_contract"].split(".")[1].isdigit()
    assert doc["envs"], "no entries"
    seen = []
    for e in doc["envs"]:
        assert e["env_id"] == e["method_id"], e
        assert e["layer_schema"] == 1, e
        assert re.match(r"^[0-9a-f]{12}$", e["source_revision"]), e
        assert re.match(r"^[0-9a-f]{40}$", e["source_tree"]), e
        assert re.match(r"^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$", e["generator_version"]), e
        assert e["tag"] == "%s-%s-%s-%s" % (e["env_id"], e["method_version"], e["arch"],
                                            e["layer_sha256"][:12]), e
        assert e["arch"] == "amd64", e
        assert len(e["layer_sha256"]) == 64 and len(e["wrapper_code_sha256"]) == 64, e
        assert e["digest"].startswith("sha256:") and len(e["digest"]) == 71, e
        assert e["base_digest"].startswith("sha256:"), e
        assert e["oci_ref"] == "ghcr.io/" + LAYER_PACKAGE, e
        family = e["base_ref"].rsplit("/", 1)[1].split(":")[0].split("-")[-1]
        assert family == ("r" if e["language"] == "R" else "py"), e
        assert e["size_bytes"] >= 1, e
        key = (e["env_id"], e["arch"])
        assert key not in seen, "duplicate (env_id, arch)"
        seen.append(key)
    assert seen == sorted(seen), "entries must be sorted by (env_id, arch)"


class PublishServerCase(unittest.TestCase):
    """Fixture publish over an in-process registry + the app-facing checks."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="txr-dev-publish-test-", dir=TEST_TMP_ROOT)
        self.out = os.path.join(self.tmpdir, "build")
        os.makedirs(self.out)
        self.data_dir = os.path.join(self.tmpdir, "registry-data")
        self.dev_registry = registry.DevRegistry(self.data_dir)
        self.server = registry.RegistryServer(("127.0.0.1", 0), self.dev_registry)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.registry_host = "127.0.0.1:%d" % self.port
        rc = publish.main(["--registry", self.registry_host, "--out", self.out,
                           "--fixture", "--skip-real"])
        assert rc == 0, "fixture publish failed"
        self.manifest_path = os.path.join(self.out, "method-env-images.fixture.json")
        with open(self.manifest_path) as f:
            self.manifest = json.load(f)
        self.entry = self.manifest["envs"][0]
        assert self.entry["env_id"] == FIXTURE_METHOD_ID
        # The tag, from the packed layer file's own bytes (not publish.py's).
        sqfs = os.path.join(self.out, "stage", "layers", FIXTURE_METHOD_ID + ".squashfs")
        self.fixture_tag = FIXTURE_TAG_PREFIX + sha256_file(sqfs)[:12]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def request(self, method, path, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=20)
        conn.request(method, path, body=body,
                     headers={"Content-Type": MANIFEST_MEDIA_TYPE} if body else {})
        resp = conn.getresponse()
        result = (resp.status, dict(resp.getheaders()), resp.read())
        conn.close()
        return result

    def get_manifest(self, name, ref):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=20)
        conn.request("GET", "/v2/%s/manifests/%s" % (name, ref),
                     headers={"Accept": MANIFEST_MEDIA_TYPE})
        resp = conn.getresponse()
        result = (resp.status, dict(resp.getheaders()), resp.read())
        conn.close()
        return result

    # ── bytes the app parses ────────────────────────────────────────────────

    def test_manifest_construction_is_the_pinned_literal(self):
        """§6.1: the registry's manifest bytes equal the pinned literal (same
        helper registry.test.py pins), byte for byte."""
        sqfs = os.path.join(self.out, "stage", "layers", FIXTURE_METHOD_ID + ".squashfs")
        status, headers, body = self.get_manifest(LAYER_PACKAGE, self.fixture_tag)
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Content-Type"), MANIFEST_MEDIA_TYPE)
        expected = artifact_manifest_bytes(
            sha256_file(sqfs), os.path.getsize(sqfs),
            {
                "org.opencontainers.image.source": "https://github.com/tinnlab/txresbench-methods",
                "org.opencontainers.image.revision": publish.SOURCE_REVISION,
                "com.txr.method_id": FIXTURE_METHOD_ID,
                "com.txr.method_version": "1.0.0",
                "com.txr.language": "Python",
                "com.txr.arch": "amd64",
                "com.txr.contract": "2.0",
                "com.txr.base_ref": "ghcr.io/tinnlab/txresbench-base-py:2.0",
                "com.txr.base_digest": self.entry["base_digest"],
                "com.txr.layer_sha256": self.entry["layer_sha256"],
                "com.txr.layer_schema": "1",
            },
        )
        self.assertEqual(body, expected, "the published manifest must be the pinned construction")

    def test_digests_agree_with_the_app_manifest(self):
        """Manifest digest == Docker-Content-Digest == dev manifest `digest`;
        blob sha256 == `layer_sha256` == the packed squashfs."""
        sqfs = os.path.join(self.out, "stage", "layers", FIXTURE_METHOD_ID + ".squashfs")
        status, headers, body = self.get_manifest(LAYER_PACKAGE, self.fixture_tag)
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Docker-Content-Digest"), self.entry["digest"])
        self.assertEqual("sha256:" + hashlib.sha256(body).hexdigest(), self.entry["digest"])
        # pull the manifest by digest, then the layer blob: the app's verify pin.
        status, _, body = self.request("GET", "/v2/%s/manifests/%s" % (
            LAYER_PACKAGE, self.entry["digest"]))
        self.assertEqual(status, 200)
        status, _, blob = self.request("GET", "/v2/%s/blobs/sha256:%s" % (
            LAYER_PACKAGE, self.entry["layer_sha256"]))
        self.assertEqual(status, 200)
        self.assertEqual(hashlib.sha256(blob).hexdigest(), self.entry["layer_sha256"])
        self.assertEqual(blob, open(sqfs, "rb").read(), "the served layer is the packed bytes")
        # the base: its tag resolves, its blob sha256 == the app's base pin.
        self.assertEqual(publish.base_tag("py", "2.0", "amd64"), FIXTURE_BASE_TAG)
        status, headers, base_body = self.get_manifest(BASE_PACKAGE, FIXTURE_BASE_TAG)
        self.assertEqual(status, 200, "the base manifest resolves at its immutable tag")
        status, _, base_blob = self.request("GET", "/v2/%s/blobs/%s" % (
            BASE_PACKAGE, "sha256:" + self.entry["base_digest"].split(":")[1]))
        self.assertEqual(status, 200)
        self.assertEqual(
            hashlib.sha256(base_blob).hexdigest(),
            self.entry["base_digest"].split(":")[1],
            "the app verifies the base payload against base_digest — the publisher pins the payload hash",
        )

    def test_app_manifest_passes_the_app_boot_rules(self):
        validate_app_manifest(self.manifest)

    def test_artifacts_are_in_the_two_packages_only(self):
        """Every layer is a tag of the one layer package, the base a tag of
        the one base package; the old per-method and per-base repos are
        empty (the app never asks for them)."""
        self.assertEqual(self.entry["oci_ref"], "ghcr.io/" + LAYER_PACKAGE)
        self.assertEqual(self.entry["tag"], self.fixture_tag)
        for package, tag in ((LAYER_PACKAGE, self.fixture_tag), (BASE_PACKAGE, FIXTURE_BASE_TAG)):
            status, _, body = self.request("GET", "/v2/%s/tags/list" % package)
            self.assertEqual(status, 200, package)
            self.assertEqual(json.loads(body)["tags"], [tag], package)
        # Nor the one-package tag without the hash.
        status, _, _ = self.get_manifest(LAYER_PACKAGE, FIXTURE_TAG_PREFIX.rstrip("-"))
        self.assertEqual(status, 404, "nothing at the tag without the layer hash")
        for old_name, old_tag in (("%s/%s" % (LAYER_PACKAGE, FIXTURE_METHOD_ID), "1.0.0-amd64"),
                                  ("%s/%s" % (BASE_PACKAGE, FIXTURE_BASE_ID), "2.0-amd64")):
            status, _, _ = self.get_manifest(old_name, old_tag)
            self.assertEqual(status, 404, "nothing at the old %s:%s" % (old_name, old_tag))

    def test_packed_layer_contract(self):
        """§5: marker, layer-manifest, /code, usr/ sentinel, modes, §2.2 hash."""
        sqfs = os.path.join(self.out, "stage", "layers", FIXTURE_METHOD_ID + ".squashfs")
        extract = os.path.join(self.out, "layer-extract")
        subprocess.run(["unsquashfs", "-d", extract, sqfs],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with open(os.path.join(extract, ".txr-method-env-layer-schema")) as f:
            self.assertEqual(f.read(), "1")
        with open(os.path.join(extract, "layer-manifest.json")) as f:
            self.assertEqual(json.load(f), ["/code"])
        self.assertTrue(os.path.isdir(os.path.join(extract, "usr")),
                        "the root-level usr/ mount-readiness sentinel")
        for rel in ("code/run.py", "code/method.json"):
            p = os.path.join(extract, rel)
            self.assertTrue(os.path.isfile(p), rel)
        for dirpath, dirnames, filenames in os.walk(extract):
            for name in dirnames:
                st = os.lstat(os.path.join(dirpath, name))
                self.assertGreaterEqual(stat.S_IMODE(st.st_mode) & 0o044, 0o044, dirpath)
            for name in filenames:
                st = os.lstat(os.path.join(dirpath, name))
                self.assertGreaterEqual(stat.S_IMODE(st.st_mode) & 0o044, 0o044, dirpath)
        with open(os.path.join(extract, "code/method.json"), "rb") as f:
            meta = f.read()
        with open(os.path.join(extract, "code/run.py"), "rb") as f:
            wrap = f.read()
        self.assertEqual(
            hashlib.sha256(meta + wrap).hexdigest(),
            self.entry["wrapper_code_sha256"],
            "design §2.2: method.json bytes || wrapper bytes",
        )

    def test_oras_dev_resolves_and_pulls(self):
        """The app's oras surface (resolve + pull) works against the pushed
        artifacts and the pulled bytes match the staged squashfs."""
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "oras_dev", os.path.join(os.path.dirname(os.path.abspath(__file__)), "oras_dev.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        ref = "127.0.0.1:%d/%s:%s" % (self.port, LAYER_PACKAGE, self.fixture_tag)
        import io
        from contextlib import redirect_stdout
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = mod.main(["resolve", "--plain-http", ref])
        self.assertEqual(rc, 0)
        self.assertEqual(buf.getvalue().strip(), self.entry["digest"])
        pull_dir = os.path.join(self.out, "pull")
        with redirect_stdout(io.StringIO()):
            rc = mod.main(["pull", "--plain-http", "-o", pull_dir, ref])
        self.assertEqual(rc, 0)
        self.assertEqual(
            hashlib.sha256(open(os.path.join(pull_dir, "layer.squashfs"), "rb").read()).hexdigest(),
            self.entry["layer_sha256"],
        )


class RealMethodsCase(unittest.TestCase):
    """The six real methods (ITEM-3: gate-failed linear-response-score
    excluded, gate-passing ctdna-anytime-detectability added): layer build +
    manifest entry rules (fast, code only — no base rebuild). The full real
    publish (bases + push) is the `TXR_DEV_TEST_REAL=1` leg; the CI-shaped
    gates of qa-hardening run the fixture contract above."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="txr-dev-publish-real-", dir=TEST_TMP_ROOT)
        self.out = os.path.join(self.tmpdir, "build")
        os.makedirs(self.out)

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_real_methods_are_the_apps_own_env_set(self):
        """ITEM-3: the real-method set must be a subset of the app's shipped
        env manifest — a dev manifest entry outside it is unreachable
        (createRun answers METHOD_NOT_FOUND). The gate-failed
        linear-response-score (pass false, spec_status blocked) is the case
        that must never come back."""
        with open(publish.APP_ENV_MANIFEST) as f:
            app_ids = {e.get("method_id") for e in json.load(f).get("envs", [])}
        self.assertTrue(publish.REAL_METHODS, "the default set is non-empty")
        self.assertTrue(
            set(publish.REAL_METHODS).issubset(app_ids),
            "REAL_METHODS must be the app's own env set: %s" % (
                set(publish.REAL_METHODS) - app_ids),
        )
        self.assertNotIn("linear-response-score", publish.REAL_METHODS)

    def test_app_manifest_membership_guard_refuses_unknown_methods(self):
        bad = "linear-response-score"
        self.assertNotIn(bad, publish.REAL_METHODS)
        with self.assertRaises(publish.PublishError) as ctx:
            publish.check_methods_in_app_manifest(["ctdna-clearance", bad])
        self.assertIn(bad, str(ctx.exception))

    def test_real_methods_produce_layers_and_manifest_entries(self):
        entries = []
        for mid in publish.REAL_METHODS:
            method_dir, spec = publish.load_method(publish.DEFAULT_METHODS_DIR, mid)
            self.assertIn(spec.get("language"), ("R", "Python"), mid)
            sqfs, env_id = publish.build_layer(method_dir, self.out, env_id=mid)
            self.assertEqual(env_id, mid)
            self.assertEqual(os.path.exists(sqfs), True)
            wrapper = publish.wrapper_code_sha256(method_dir)
            self.assertEqual(len(wrapper), 64)
            entries.append({
                "env_id": mid, "method_id": mid,
                "method_version": spec.get("version", "0.0.0"),
                "language": spec.get("language", "Python"),
                "arch": "amd64",
                "oci_ref": publish.LAYER_OCI_REF,
                "tag": publish.layer_tag(mid, spec.get("version", "0.0.0"), "amd64",
                                         sha256_file(sqfs)),
                "digest": "sha256:" + sha256_file(sqfs),
                "layer_sha256": sha256_file(sqfs),
                "size_bytes": os.path.getsize(sqfs),
                "base_ref": "ghcr.io/tinnlab/txresbench-base-%s:2.0" % publish.BASE_FAMILY[spec.get("language", "Python")],
                "base_digest": "sha256:" + "0" * 64,
                "contract": "2.0",
                "licence": spec.get("licence", ""),
                "wrapper_code_sha256": wrapper,
                "layer_schema": 1,
            })
        doc = {
            "schema_version": 2, "generator_version": publish.GENERATOR_VERSION,
            "base_contract": publish.CONTRACT,
            "envs": [{**e, **publish.provenance_fields(publish.DEFAULT_METHODS_DIR, e["env_id"])}
                     for e in entries],
        }
        validate_app_manifest(doc)
        langs = {e["language"] for e in entries}
        self.assertEqual(langs, {"R", "Python"}, "both kinds (response-call + survival/risk)")

    @unittest.skipUnless(os.environ.get("TXR_DEV_TEST_REAL"), "TXR_DEV_TEST_REAL=1 for the full real publish")
    def test_full_real_publish_matches_the_same_contract(self):
        out = os.path.join(self.tmpdir, "build")
        rc = publish.main(["--no-push", "--out", out])
        self.assertEqual(rc, 0)
        with open(os.path.join(out, "method-env-images.dev.json")) as f:
            doc = json.load(f)
        validate_app_manifest(doc)
        ids = {e["env_id"] for e in doc["envs"]}
        self.assertEqual(ids, set(publish.REAL_METHODS))
        for entry in doc["envs"]:
            self.assertTrue(entry["digest"].startswith("sha256:"), entry["env_id"])



class HostPythonCase(unittest.TestCase):
    """The dev base copies the host's own system python3, whatever its
    minor version, not a hard-coded 3.10 (a bookworm box has 3.11 only, and a
    fixture base built there would have no python3 at all)."""

    def test_version_follows_the_python3_link(self):
        d = tempfile.mkdtemp(dir=TEST_TMP_ROOT)
        try:
            link = os.path.join(d, "python3")
            os.symlink("/usr/bin/python3.11", link)
            self.assertEqual(publish._host_python_version(link), "3.11")
            os.unlink(link)
            os.symlink("/usr/bin/python3.10", link)
            self.assertEqual(publish._host_python_version(link), "3.10")
        finally:
            shutil.rmtree(d)

    def test_no_link_falls_back_to_3_10(self):
        d = tempfile.mkdtemp(dir=TEST_TMP_ROOT)
        try:
            self.assertEqual(publish._host_python_version(os.path.join(d, "absent")), "3.10")
        finally:
            shutil.rmtree(d)

    def test_paths_follow_the_version(self):
        self.assertEqual(publish.PY_BIN, "/usr/bin/python" + publish.PY_VERSION)
        self.assertEqual(publish.PY_STDLIB, "/usr/lib/python" + publish.PY_VERSION)


class StageFixtureCase(unittest.TestCase):
    """--stage-fixture: the bases scenario's build dir in the generator's
    format, written by the generator's own base pack, assembles into a
    manifest whose `bases` record pins the base FILE (never the provenance
    digest) and pairs with the layer."""

    GENERATOR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..",
                             "generate-method-env-images.py")

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="txr-dev-stage-test-", dir=TEST_TMP_ROOT)

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_stage_fixture_writes_a_generator_build_dir_with_a_paired_base(self):
        stage = os.path.join(self.tmpdir, "stage")
        self.assertEqual(publish.main(["--stage-fixture", stage]), 0)
        arch = publish.ARCH
        base_dir = os.path.join(stage, "bases", "base-py-" + arch)
        with open(os.path.join(base_dir, "artifact.json")) as f:
            base = json.load(f)
        self.assertEqual(base["kind"], "base")
        self.assertEqual(base["squashfs_sha256"], sha256_file(os.path.join(base_dir, "base.squashfs")))
        self.assertEqual(base["oci_ref"], "ghcr.io/" + BASE_PACKAGE)
        self.assertEqual(base["tag"], "base-py-2.0-%s-%s" % (arch, base["squashfs_sha256"][:12]))
        layer_dir = os.path.join(stage, "layers", "%s-%s" % (publish.FIXTURE_B_METHOD_ID, arch))
        with open(os.path.join(layer_dir, "artifact.json")) as f:
            layer = json.load(f)
        self.assertEqual(layer["layer_sha256"], sha256_file(os.path.join(layer_dir, "layer.squashfs")))
        self.assertEqual(layer["base_digest"], base["source_digest"])
        self.assertEqual((layer["oci_ref"], layer["tag"]),
                         ("ghcr.io/" + LAYER_PACKAGE, "%s-1.0.0-%s-%s" % (
                             publish.FIXTURE_B_METHOD_ID, arch, layer["layer_sha256"][:12])),
                         "the generator's own record form")

        manifest = os.path.join(self.tmpdir, "manifest.json")
        r = subprocess.run([sys.executable, self.GENERATOR, "--fixture", stage,
                            "--methods-dir", os.path.join(stage, "methods"),
                            "--manifest", manifest, "--full"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        with open(manifest) as f:
            doc = json.load(f)
        self.assertEqual([(b["base_id"], b["arch"]) for b in doc["bases"]], [("base-py", arch)])
        b, e = doc["bases"][0], doc["envs"][0]
        self.assertEqual(e["env_id"], publish.FIXTURE_B_METHOD_ID)
        self.assertEqual((e["oci_ref"], e["tag"]), (layer["oci_ref"], layer["tag"]))
        self.assertEqual((b["oci_ref"], b["tag"]), (base["oci_ref"], base["tag"]))
        self.assertEqual(b["squashfs_sha256"], base["squashfs_sha256"])
        self.assertEqual(e["base_digest"], b["source_digest"], "the pairing (design §7)")
        self.assertNotEqual(e["base_digest"], "sha256:" + b["squashfs_sha256"],
                            "the provenance digest is never the file pin")
        listing = subprocess.run(["unsquashfs", "-lln", os.path.join(base_dir, "base.squashfs")],
                                 capture_output=True, text=True, check=True).stdout
        for rel in ("opt/txr-layer", "usr/bin/prlimit", "usr/bin/bash"):
            self.assertIn("squashfs-root/" + rel, listing)


if __name__ == "__main__":
    unittest.main(verbosity=2)
