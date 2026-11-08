#!/usr/bin/env python3
"""Tests for scripts/dev-registry/registry.py (TEST-QA-1).

Unittest, stdlib only, no docker, no oras, no network beyond loopback: a
server instance starts on an ephemeral port in the background and the wire
flows are driven with http.client the way oras and the app's get/HEAD client
behave (POST → PATCH → PUT?digest=, monolithic PUT, chunked PATCH, manifest
PUT by tag with the artifact-manifest construction of
docs/design/method-env-layer-artifacts.md §6.1, manifest GET by tag and by
digest, blob range GET, tags/list, DELETE, restart persistence).

Run: python3 scripts/dev-registry/registry.test.py
"""

import hashlib
import http.client
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import registry  # noqa: E402


def _pick_tmp_root():
    """Owner rule: working files never under /tmp. Prefer TMPDIR when it is
    usable; fall back to the box's app-work scratch space. The git-work-tree
    test is the registry's own refusal rule — on this box the default TMPDIR
    (cap.sh's tmp/job) lies inside a git work tree, so it is unusable here."""
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
    raise SystemExit("dev-registry tests: no usable tmp root (TMPDIR is unusable)")


TEST_TMP_ROOT = _pick_tmp_root()

EMPTY_CONFIG = b"{}"
EMPTY_CONFIG_DIGEST = "sha256:" + hashlib.sha256(EMPTY_CONFIG).hexdigest()
# The OCI empty-descriptor digest the artifact construction pins (§6.1).
EMPTY_CONFIG_LITERAL = "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"

MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json"
ARTIFACT_MEDIA_TYPE = "application/vnd.txr.method-env.layer.v1"

LAYER_REPO = "tinnlab/txr-method-env-layers/demo-method"
BASE_REPO = "tinnlab/txresbench-env/base-r"


def sha(text):
    return "sha256:" + hashlib.sha256(text).hexdigest()


def artifact_manifest(layer_bytes, annotations=None):
    """The §6.1 pinned construction: field order, no whitespace, ASCII only."""
    doc = {
        "schemaVersion": 2,
        "mediaType": MANIFEST_MEDIA_TYPE,
        "artifactType": ARTIFACT_MEDIA_TYPE,
        "config": {
            "mediaType": "application/vnd.oci.empty.v1+json",
            "digest": EMPTY_CONFIG_DIGEST,
            "size": len(EMPTY_CONFIG),
        },
        "layers": [{
            "mediaType": ARTIFACT_MEDIA_TYPE,
            "digest": sha(layer_bytes),
            "size": len(layer_bytes),
            "annotations": {"org.opencontainers.image.title": "layer.squashfs"},
        }],
        "annotations": annotations or {
            "org.opencontainers.image.source": "https://github.com/tinnlab/txresbench-methods",
            "org.opencontainers.image.revision": "0123456789ab",
            "com.txr.method_id": "demo-method",
            "com.txr.method_version": "1.0.0",
            "com.txr.language": "R",
            "com.txr.arch": "amd64",
            "com.txr.contract": "2.0",
            "com.txr.base_ref": "ghcr.io/tinnlab/txresbench-base-r:2.0",
            "com.txr.base_digest": sha(b"base-bytes"),
            "com.txr.layer_sha256": hashlib.sha256(layer_bytes).hexdigest(),
            "com.txr.layer_schema": "1",
        },
    }
    return json.dumps(doc, separators=(",", ":")).encode("utf-8")


class RegistryServerCase(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="txr-dev-registry-test-", dir=TEST_TMP_ROOT)
        self.data_dir = os.path.join(self.tmpdir, "registry-data")
        self.registry = registry.DevRegistry(self.data_dir)
        self.server = registry.RegistryServer(("127.0.0.1", 0), self.registry)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def request(self, method, path, body=None, headers=None, chunked_payload=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.putrequest(method, path)
        for key, value in (headers or {}).items():
            conn.putheader(key, value)
        if chunked_payload is not None:
            conn.putheader("Transfer-Encoding", "chunked")
            conn.endheaders()
            for chunk in chunked_payload:
                conn.send(b"%x\r\n%s\r\n" % (len(chunk), chunk))
            conn.send(b"0\r\n\r\n")
        else:
            conn.putheader("Content-Length", str(len(body or b"")))
            conn.endheaders()
            if body:
                conn.send(body)
        resp = conn.getresponse()
        result = (resp.status, dict(resp.getheaders()), resp.read())
        conn.close()
        return result

    def upload_blob(self, name, data, chunked=False):
        status, headers, _ = self.request("POST", "/v2/%s/blobs/uploads/" % name)
        self.assertEqual(status, 202)
        self.assertIn("Location", headers)
        self.assertIn("Docker-Upload-UUID", headers)
        location = headers["Location"]
        digest = sha(data)
        if chunked:
            mid = len(data) // 2
            status, headers, _ = self.request(
                "PATCH", location, chunked_payload=[data[:mid], data[mid:]],
                headers={"Content-Type": "application/octet-stream"})
            self.assertEqual(status, 202)
            self.assertEqual(headers["Range"], "0-%d" % (len(data) - 1))
            status, headers, _ = self.request("PUT", location + "?digest=" + digest)
        else:
            status, headers, _ = self.request(
                "PUT", location + "?digest=" + digest, body=data,
                headers={"Content-Type": "application/octet-stream"})
        self.assertEqual(status, 201, headers)
        self.assertEqual(headers["Docker-Content-Digest"], digest)
        return digest

    def push_manifest(self, name, ref, layer_bytes, content_type=MANIFEST_MEDIA_TYPE):
        self.upload_blob(name, EMPTY_CONFIG)
        self.upload_blob(name, layer_bytes)
        body = artifact_manifest(layer_bytes)
        status, headers, _ = self.request(
            "PUT", "/v2/%s/manifests/%s" % (name, ref), body=body,
            headers={"Content-Type": content_type})
        self.assertEqual(status, 201, headers)
        self.assertEqual(headers["Docker-Content-Digest"], sha(body))
        return body, sha(body)


class TestVersionCheck(RegistryServerCase):
    def test_api_version_endpoint(self):
        status, headers, body = self.request("GET", "/v2/")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Docker-Distribution-API-Version"], "registry/2.0")
        self.assertEqual(body, b"{}")

    def test_unknown_path_is_404_json(self):
        status, _, body = self.request("GET", "/v2/unknown/thing")
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body)["errors"][0]["code"], "UNSUPPORTED")


class TestBlobUpload(RegistryServerCase):
    def test_monolithic_upload_and_read(self):
        data = b"layer.squashfs bytes" * 100
        digest = self.upload_blob(LAYER_REPO, data)
        status, headers, _ = self.request("HEAD", "/v2/%s/blobs/%s" % (LAYER_REPO, digest))
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Length"], str(len(data)))
        self.assertEqual(headers["Docker-Content-Digest"], digest)
        self.assertEqual(headers["Content-Type"], "application/octet-stream")
        status, headers, body = self.request("GET", "/v2/%s/blobs/%s" % (LAYER_REPO, digest))
        self.assertEqual(status, 200)
        self.assertEqual(body, data)
        self.assertEqual(headers["Content-Length"], str(len(data)))

    def test_chunked_upload(self):
        data = b"".join(bytes([i % 256]) for i in range(300))
        digest = self.upload_blob(LAYER_REPO, data, chunked=True)
        status, _, body = self.request("GET", "/v2/%s/blobs/%s" % (LAYER_REPO, digest))
        self.assertEqual(body, data)

    def test_post_body_then_put_finalize(self):
        data = b"monolithic post body"
        digest = sha(data)
        status, headers, _ = self.request("POST", "/v2/%s/blobs/uploads/" % LAYER_REPO, body=data)
        self.assertEqual(status, 202)
        status, headers, _ = self.request("PUT", headers["Location"] + "?digest=" + digest)
        self.assertEqual(status, 201)
        status, _, body = self.request("GET", "/v2/%s/blobs/%s" % (LAYER_REPO, digest))
        self.assertEqual(body, data)

    def test_digest_mismatch_refused(self):
        data = b"tampered layer bytes"
        status, headers, _ = self.request("POST", "/v2/%s/blobs/uploads/" % LAYER_REPO)
        location = headers["Location"]
        wrong = sha(b"other bytes")
        status, _, body = self.request("PUT", location + "?digest=" + wrong, body=data)
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["errors"][0]["code"], "DIGEST_INVALID")
        status, _, _ = self.request("HEAD", "/v2/%s/blobs/%s" % (LAYER_REPO, wrong))
        self.assertEqual(status, 404)

    def test_invalid_digest_format_refused(self):
        status, headers, _ = self.request("POST", "/v2/%s/blobs/uploads/" % LAYER_REPO)
        status, _, body = self.request("PUT", headers["Location"] + "?digest=sha256:zz", body=b"x")
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["errors"][0]["code"], "DIGEST_INVALID")

    def test_blob_is_namespaced_per_repo(self):
        data = b"base rootfs"
        digest = self.upload_blob(BASE_REPO, data)
        # The layer repo exists (its own blob is uploaded first) but has no
        # link to the base blob: repo-scoped visibility, not global.
        self.upload_blob(LAYER_REPO, b"layer repo exists")
        path = "/v2/%s/blobs/%s" % (LAYER_REPO, digest)
        status, _, _ = self.request("HEAD", path)
        self.assertEqual(status, 404)
        status, _, body = self.request("GET", path)
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body)["errors"][0]["code"], "BLOB_UNKNOWN")

    def test_cross_repo_mount(self):
        data = b"shared blob bytes"
        digest = self.upload_blob(BASE_REPO, data)
        status, headers, _ = self.request(
            "POST", "/v2/%s/blobs/uploads/?mount=%s&from=%s" % (LAYER_REPO, digest, BASE_REPO))
        self.assertEqual(status, 201)
        self.assertEqual(headers["Docker-Content-Digest"], digest)
        status, _, body = self.request("GET", "/v2/%s/blobs/%s" % (LAYER_REPO, digest))
        self.assertEqual(body, data)


class TestBlobRange(RegistryServerCase):
    def test_range_get(self):
        data = b"0123456789abcdef" * 8
        digest = self.upload_blob(LAYER_REPO, data)
        status, headers, body = self.request(
            "GET", "/v2/%s/blobs/%s" % (LAYER_REPO, digest), headers={"Range": "bytes=5-9"})
        self.assertEqual(status, 206)
        self.assertEqual(body, data[5:10])
        self.assertEqual(headers["Content-Range"], "bytes 5-9/%d" % len(data))
        self.assertEqual(headers["Content-Length"], "5")
        status, headers, body = self.request(
            "GET", "/v2/%s/blobs/%s" % (LAYER_REPO, digest), headers={"Range": "bytes=13-"})
        self.assertEqual(status, 206)
        self.assertEqual(body, data[13:])
        self.assertEqual(headers["Content-Range"], "bytes 13-%d/%d" % (len(data) - 1, len(data)))
        status, headers, body = self.request(
            "GET", "/v2/%s/blobs/%s" % (LAYER_REPO, digest), headers={"Range": "bytes=9999-10002"})
        self.assertEqual(status, 416)
        self.assertEqual(headers["Content-Range"], "bytes */%d" % len(data))

    def test_head_range(self):
        data = b"range head data"
        digest = self.upload_blob(LAYER_REPO, data)
        status, headers, body = self.request(
            "HEAD", "/v2/%s/blobs/%s" % (LAYER_REPO, digest), headers={"Range": "bytes=1-3"})
        self.assertEqual(status, 206)
        self.assertEqual(body, b"")
        self.assertEqual(headers["Content-Length"], "3")


class TestManifest(RegistryServerCase):
    def test_manifest_roundtrip_by_tag_and_digest(self):
        layer = b"real layer.squashfs bytes"
        body, manifest_digest = self.push_manifest(LAYER_REPO, "1.0.0-amd64", layer)
        status, headers, got = self.request("GET", "/v2/%s/manifests/1.0.0-amd64" % LAYER_REPO)
        self.assertEqual(status, 200)
        self.assertEqual(got, body)
        self.assertEqual(headers["Content-Type"], MANIFEST_MEDIA_TYPE)
        self.assertEqual(headers["Docker-Content-Digest"], manifest_digest)
        self.assertEqual(headers["Content-Length"], str(len(body)))
        status, headers, _ = self.request("HEAD", "/v2/%s/manifests/%s" % (LAYER_REPO, manifest_digest))
        self.assertEqual(status, 200)
        self.assertEqual(headers["Docker-Content-Digest"], manifest_digest)
        status, _, got = self.request("GET", "/v2/%s/manifests/%s" % (LAYER_REPO, manifest_digest))
        self.assertEqual(status, 200)
        self.assertEqual(got, body)
        status, _, list_body = self.request("GET", "/v2/%s/tags/list" % LAYER_REPO)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(list_body), {"name": LAYER_REPO, "tags": ["1.0.0-amd64"]})

    def test_empty_config_digest_is_the_oci_literal(self):
        self.assertEqual(EMPTY_CONFIG_DIGEST, EMPTY_CONFIG_LITERAL)

    def test_manifest_refuses_missing_blob(self):
        missing_layer = b"never uploaded"
        doc = {
            "schemaVersion": 2,
            "mediaType": MANIFEST_MEDIA_TYPE,
            "config": {"mediaType": "application/vnd.oci.empty.v1+json",
                       "digest": EMPTY_CONFIG_DIGEST, "size": 2},
            "layers": [{"mediaType": ARTIFACT_MEDIA_TYPE,
                        "digest": sha(missing_layer), "size": len(missing_layer)}],
        }
        status, _, body = self.request(
            "PUT", "/v2/%s/manifests/1.0.0-amd64" % LAYER_REPO,
            body=json.dumps(doc, separators=(",", ":")).encode("utf-8"),
            headers={"Content-Type": MANIFEST_MEDIA_TYPE})
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["errors"][0]["code"], "MANIFEST_BLOB_UNKNOWN")

    def test_manifest_digest_ref_mismatch_refused(self):
        self.upload_blob(LAYER_REPO, EMPTY_CONFIG)
        self.upload_blob(LAYER_REPO, b"layer bytes")
        body = artifact_manifest(b"layer bytes")
        wrong = sha(b"different manifest bytes")
        status, _, resp = self.request(
            "PUT", "/v2/%s/manifests/%s" % (LAYER_REPO, wrong), body=body,
            headers={"Content-Type": MANIFEST_MEDIA_TYPE})
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(resp)["errors"][0]["code"], "DIGEST_INVALID")

    def test_manifest_put_by_digest(self):
        self.upload_blob(LAYER_REPO, EMPTY_CONFIG)
        self.upload_blob(LAYER_REPO, b"layer bytes")
        body = artifact_manifest(b"layer bytes")
        digest = sha(body)
        status, headers, _ = self.request(
            "PUT", "/v2/%s/manifests/%s" % (LAYER_REPO, digest), body=body,
            headers={"Content-Type": MANIFEST_MEDIA_TYPE})
        self.assertEqual(status, 201)
        self.assertEqual(headers["Docker-Content-Digest"], digest)
        status, _, _ = self.request("HEAD", "/v2/%s/manifests/%s" % (LAYER_REPO, digest))
        self.assertEqual(status, 200)
        status, _, list_body = self.request("GET", "/v2/%s/tags/list" % LAYER_REPO)
        self.assertEqual(json.loads(list_body)["tags"], [])

    def test_delete_manifest(self):
        layer = b"layer to delete"
        body, digest = self.push_manifest(LAYER_REPO, "1.0.0-amd64", layer)
        status, _, _ = self.request("DELETE", "/v2/%s/manifests/%s" % (LAYER_REPO, digest))
        self.assertEqual(status, 202)
        status, _, _ = self.request("GET", "/v2/%s/manifests/1.0.0-amd64" % LAYER_REPO)
        self.assertEqual(status, 404)
        status, _, list_body = self.request("GET", "/v2/%s/tags/list" % LAYER_REPO)
        self.assertEqual(json.loads(list_body)["tags"], [])

    def test_names_with_slashes(self):
        layer = b"nested repo layer"
        name = "tinnlab/txr-method-env-layers/deep/nested-id"
        self.assertFalse(registry.DevRegistry.valid_name("TinnLab/x"))
        body, digest = self.push_manifest(name, "2.0.0-amd64", layer)
        status, _, got = self.request("GET", "/v2/%s/manifests/2.0.0-amd64" % name)
        self.assertEqual(got, body)
        self.assertEqual(sha(body), digest)


class TestRestartPersistence(RegistryServerCase):
    def test_restart_keeps_blobs_and_tags(self):
        layer = b"persistent layer bytes"
        self.push_manifest(BASE_REPO, "2.0-amd64", layer)
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.registry = registry.DevRegistry(self.data_dir)
        self.server = registry.RegistryServer(("127.0.0.1", 0), self.registry)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        digest = sha(layer)
        status, headers, _ = self.request("HEAD", "/v2/%s/blobs/%s" % (BASE_REPO, digest))
        self.assertEqual(status, 200)
        status, _, body = self.request("GET", "/v2/%s/manifests/2.0-amd64" % BASE_REPO)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["layers"][0]["digest"], digest)
        status, _, list_body = self.request("GET", "/v2/%s/tags/list" % BASE_REPO)
        self.assertEqual(json.loads(list_body)["tags"], ["2.0-amd64"])


class TestDataDirRefusal(unittest.TestCase):
    def test_refuses_path_inside_git_worktree(self):
        tmpdir = tempfile.mkdtemp(prefix="txr-dev-registry-git-", dir=TEST_TMP_ROOT)
        try:
            worktree = os.path.join(tmpdir, "repo")
            os.makedirs(os.path.join(worktree, ".git"))
            data_dir = os.path.join(worktree, "registry-data")
            with self.assertRaises(ValueError) as cm:
                registry.validate_data_dir(data_dir)
            self.assertIn("git work tree", str(cm.exception))
            self.assertEqual(registry.main(["--dir", data_dir, "--port", "0"]), 2)
            self.assertFalse(os.path.exists(data_dir))
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_refuses_file_git_worktree_marker(self):
        tmpdir = tempfile.mkdtemp(prefix="txr-dev-registry-git-", dir=TEST_TMP_ROOT)
        try:
            worktree = os.path.join(tmpdir, "repo")
            os.makedirs(worktree)
            with open(os.path.join(worktree, ".git"), "w", encoding="utf-8") as fh:
                fh.write("gitdir: /elsewhere/.git/worktrees/repo\n")
            with self.assertRaises(ValueError):
                registry.validate_data_dir(os.path.join(worktree, "data"))
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_accepts_plain_directory(self):
        tmpdir = tempfile.mkdtemp(prefix="txr-dev-registry-ok-", dir=TEST_TMP_ROOT)
        try:
            data_dir = os.path.join(tmpdir, "data")
            self.assertEqual(str(registry.validate_data_dir(data_dir)), os.path.realpath(data_dir))
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
