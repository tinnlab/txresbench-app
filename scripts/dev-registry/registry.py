#!/usr/bin/env python3
"""dev-registry — a minimal OCI distribution v2 registry for TxResBench development.

The TxResBench desktop app fetches each method's analysis environment from a
container registry (an OCI distribution v2 server). During development and
testing the app is pointed at a loopback registry instead of the public one,
through the server's registry-host seam
(``src-app/server/src/modules/sandbox/method_env.rs``, ``MethodEnvSeams``).

This module is that loopback registry. It lets the app's fetch → verify →
mount path be exercised locally with no docker, no registry container and no
network use. It is test infrastructure: no authentication, loopback binding by
default, and all state under one data directory.

Supported OCI distribution v2 surface (the subset the app's fetch and the
local publisher use):

- ``GET /v2/`` — the API version check;
- ``HEAD | GET /v2/<name>/blobs/<digest>`` — blob existence/read (range GET
  with ``Range: bytes=start-end`` or ``bytes=start-``);
- ``POST /v2/<name>/blobs/uploads/`` — upload session start (``?mount=<digest>
  &from=<repo>`` cross-repo mount when the blob is already stored);
- ``PATCH /v2/<name>/blobs/uploads/<id>`` — append bytes (monolithic bodies
  sent directly to ``POST`` or to the final ``PUT`` are accepted too);
- ``PUT /v2/<name>/blobs/uploads/<id>?digest=<digest>`` — finalize the upload;
  the digest is verified against the stored bytes and a mismatch is refused;
- ``HEAD | GET | PUT /v2/<name>/manifests/<ref>`` — manifest by tag or digest;
- ``DELETE /v2/<name>/manifests/<ref>`` — remove a manifest (and the tags
  pointing at it);
- ``GET /v2/<name>/tags/list`` — the repository's tags.

Repository names may contain slashes; the registries the app knows are
``tinnlab/txresbench-env`` (per-language trimmed bases) and
``tinnlab/txr-method-env-layers/<method>`` (per-method layers).

Storage layout (content-addressed blobs + tag files, so a restart keeps all
data):

    $TXR_DEV_REGISTRY_DIR/
      blobs/sha256/<hex>                  raw bytes of every blob and manifest
      repos/<name>/tags/<tag>             the manifest digest ("sha256:<hex>") the tag points at
      repos/<name>/blobs/sha256~<hex>     marker: this repo references the blob
      repos/<name>/manifests/sha256~<hex> marker: this repo holds the manifest
      repos/<name>/media/sha256~<hex>     manifest Content-Type value
      tmp/                                in-progress upload sessions

Usage::

    TXR_DEV_REGISTRY_DIR=/data/pbya/txresbench-app-work/registry-data \
        python3 scripts/dev-registry/registry.py --port 5055

The data directory is refused when it lies inside a git work tree (a
worktree is identified by an ancestor directory holding a ``.git`` entry —
file or directory), so registry state can never become repo noise.
"""

import argparse
import hashlib
import json
import os
import re
import sys
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

DEFAULT_DATA_DIR = "/data/pbya/txresbench-app-work/registry-data"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 5055

API_VERSION = "registry/2.0"

# Only sha256 digests are accepted (the app pins sha256 everywhere; oras uses
# sha256; the artifact manifest bytes are constructed around it).
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")

# OCI: repository names are lowercase, slash-separated components.
NAME_COMPONENT_RE = re.compile(r"^[a-z0-9]+(?:[._-][a-z0-9]+)*$")
TAG_RE = re.compile(r"^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$")

BLOB_CONTENT_TYPE = "application/octet-stream"

# /v2/<name>/blobs/<digest | uploads/...>, /v2/<name>/manifests/<ref>,
# /v2/<name>/tags/list. The name is greedy so a repository name that itself
# contains one of the resource words still splits at the LAST occurrence.
ROUTE_RE = re.compile(
    r"^/v2/(?P<name>.+)/(?P<kind>blobs|manifests|tags/list)(?:/(?P<rest>.*))?$"
)


def validate_data_dir(path):
    """Return the resolved data dir, refusing any path inside a git work tree.

    Raises ValueError with a concrete reason. The check walks the existing
    ancestors of the (possibly not-yet-created) path and refuses when any of
    them holds a ``.git`` entry — a worktree root carries ``.git`` as a file,
    a normal checkout as a directory.
    """
    resolved = Path(path).expanduser().resolve()
    probe = resolved
    while True:
        if probe.exists() and (probe / ".git").exists():
            raise ValueError(
                "registry data dir refused: %s lies inside a git work tree "
                "(ancestor %s holds .git)" % (resolved, probe)
            )
        if probe == probe.parent:
            break
        probe = probe.parent
    return resolved


class DevRegistry:
    """The content-addressed store: blobs, manifests, tags, upload sessions."""

    def __init__(self, root):
        self.root = validate_data_dir(root)
        self._uploads = {}  # session id -> {"name", "part", "size"}
        self.root.mkdir(parents=True, exist_ok=True)
        self.blob_dir.mkdir(parents=True, exist_ok=True)
        self.tmp_dir.mkdir(parents=True, exist_ok=True)
        # Sessions live in memory; a leftover spool from a crashed run is dead.
        for part in self.tmp_dir.glob("*.part"):
            part.unlink(missing_ok=True)

    # -- paths -------------------------------------------------------------

    @property
    def blob_dir(self):
        return self.root / "blobs" / "sha256"

    @property
    def tmp_dir(self):
        return self.root / "tmp"

    def repos_dir(self):
        return self.root / "repos"

    def repo_dir(self, name):
        return self.repos_dir() / name

    def tag_path(self, name, tag):
        return self.repo_dir(name) / "tags" / tag

    def blob_link_path(self, name, digest):
        return self.repo_dir(name) / "blobs" / digest.replace(":", "~")

    def manifest_marker_path(self, name, digest):
        return self.repo_dir(name) / "manifests" / digest.replace(":", "~")

    def media_path(self, name, digest):
        return self.repo_dir(name) / "media" / digest.replace(":", "~")

    # -- names --------------------------------------------------------------

    @staticmethod
    def valid_name(name):
        return all(NAME_COMPONENT_RE.match(part) for part in name.split("/"))

    @staticmethod
    def valid_tag(tag):
        return bool(TAG_RE.match(tag))

    @staticmethod
    def valid_digest(digest):
        return bool(DIGEST_RE.match(digest))

    # -- blobs (bytes are global; visibility is per repo) --------------------

    def blob_path(self, digest):
        return self.blob_dir / digest.split(":", 1)[1]

    def has_blob_bytes(self, digest):
        return self.blob_path(digest).is_file()

    def repo_has_blob(self, name, digest):
        return self.blob_link_path(name, digest).is_file()

    def store_blob(self, name, digest, data):
        """Store verified bytes (idempotent) and link them into the repo. Atomic."""
        self.blob_dir.mkdir(parents=True, exist_ok=True)
        dest = self.blob_path(digest)
        if not dest.exists():
            tmp = dest.with_name(dest.name + ".tmp-" + uuid.uuid4().hex)
            with open(tmp, "wb") as fh:
                fh.write(data)
            os.replace(tmp, dest)
        link = self.blob_link_path(name, digest)
        link.parent.mkdir(parents=True, exist_ok=True)
        link.touch()
        return dest

    # -- tags / manifests ----------------------------------------------------

    def tag_digest(self, name, tag):
        path = self.tag_path(name, tag)
        if not path.is_file():
            return None
        return path.read_text(encoding="utf-8").strip() or None

    def set_tag(self, name, tag, digest):
        path = self.tag_path(name, tag)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
        tmp.write_text(digest, encoding="utf-8")
        os.replace(tmp, path)

    def repo_tags(self, name):
        d = self.repo_dir(name) / "tags"
        if not d.is_dir():
            return []
        return sorted(p.name for p in d.iterdir() if p.is_file())

    def manifest_media_type(self, name, digest):
        p = self.media_path(name, digest)
        if not p.is_file():
            return None
        return p.read_text(encoding="utf-8").strip() or None

    def put_manifest(self, name, ref, body, content_type):
        """Validate + store a manifest; returns (digest, error_code, message).

        error_code is None on success and one of the OCI error codes
        (DIGEST_INVALID, MANIFEST_INVALID, MANIFEST_BLOB_UNKNOWN) otherwise.
        """
        if ref and not (DIGEST_RE.match(ref) or self.valid_tag(ref)):
            return None, "DIGEST_INVALID", "unsupported manifest reference: %r" % ref
        try:
            doc = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return None, "MANIFEST_INVALID", "manifest body is not valid JSON"
        if not isinstance(doc, dict) or doc.get("schemaVersion") != 2:
            return None, "MANIFEST_INVALID", "manifest must be a schemaVersion 2 document"
        config = doc.get("config")
        if not isinstance(config, dict) or not DIGEST_RE.match(str(config.get("digest", ""))):
            return None, "MANIFEST_INVALID", "manifest config descriptor is missing or invalid"
        refs = [str(config["digest"])] + [
            str(layer.get("digest", ""))
            for layer in doc.get("layers", [])
            if isinstance(layer, dict)
        ]
        for ref_digest in refs:
            if not DIGEST_RE.match(ref_digest):
                return None, "MANIFEST_INVALID", "manifest references an invalid digest"
            if not self.has_blob_bytes(ref_digest):
                return None, "MANIFEST_BLOB_UNKNOWN", (
                    "manifest references a blob not present in the registry: %s" % ref_digest
                )
        digest = "sha256:" + hashlib.sha256(body).hexdigest()
        if DIGEST_RE.match(ref) and ref != digest:
            return None, "DIGEST_INVALID", (
                "manifest digest mismatch: pushed %s, reference is %s" % (digest, ref)
            )
        self.store_blob(name, digest, body)
        if not DIGEST_RE.match(ref):
            self.set_tag(name, ref, digest)
        media = self.media_path(name, digest)
        media.parent.mkdir(parents=True, exist_ok=True)
        media.write_text(
            content_type or "application/vnd.oci.image.manifest.v1+json", encoding="utf-8"
        )
        marker = self.manifest_marker_path(name, digest)
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.touch()
        return digest, None, ""

    def delete_manifest(self, name, ref):
        """Remove a manifest by digest or tag. Returns True when something was removed."""
        if DIGEST_RE.match(ref):
            digest = ref
            removed = False
            for tag in list(self.repo_tags(name)):
                if self.tag_digest(name, tag) == digest:
                    self.tag_path(name, tag).unlink(missing_ok=True)
                    removed = True
            marker = self.manifest_marker_path(name, digest)
            if marker.exists():
                marker.unlink()
                removed = True
            media = self.media_path(name, digest)
            media.unlink(missing_ok=True)
            return removed
        path = self.tag_path(name, ref)
        if not path.is_file():
            return False
        digest = self.tag_digest(name, ref)
        path.unlink()
        self.manifest_marker_path(name, digest).unlink(missing_ok=True)
        self.media_path(name, digest).unlink(missing_ok=True)
        return True

    def read_manifest(self, name, ref):
        """Return (body, media_type) or None when the manifest is not in this repo."""
        if DIGEST_RE.match(ref):
            digest = ref
            if not self.manifest_marker_path(name, digest).is_file():
                return None
        else:
            digest = self.tag_digest(name, ref)
            if digest is None:
                return None
        path = self.blob_path(digest)
        if not path.is_file():
            return None
        with open(path, "rb") as fh:
            body = fh.read()
        return body, self.manifest_media_type(name, digest) or BLOB_CONTENT_TYPE

    # -- upload sessions ------------------------------------------------------

    def begin_upload(self, name, data=b""):
        session_id = uuid.uuid4().hex
        part = self.tmp_dir / (session_id + ".part")
        with open(part, "wb") as fh:
            fh.write(data)
        self._uploads[session_id] = {"name": name, "part": part, "size": len(data)}
        return session_id

    def append_upload(self, session_id, data):
        session = self._uploads.get(session_id)
        if session is None:
            return None
        with open(session["part"], "ab") as fh:
            fh.write(data)
        session["size"] += len(data)
        return session["size"]

    def finalize_upload(self, session_id, digest):
        """Verify the session bytes against the route's digest. Returns a
        (status, code, message, location) tuple; on success the blob is stored."""
        session = self._uploads.get(session_id)
        if session is None:
            return 404, "BLOB_UPLOAD_UNKNOWN", "unknown upload session", None
        part = session["part"]
        del self._uploads[session_id]
        with open(part, "rb") as fh:
            data = fh.read()
        part.unlink(missing_ok=True)
        if not DIGEST_RE.match(digest):
            return 400, "DIGEST_INVALID", "invalid digest: %r" % digest, None
        actual = "sha256:" + hashlib.sha256(data).hexdigest()
        if actual != digest:
            return 400, "DIGEST_INVALID", (
                "provided digest did not match uploaded content: %s != %s" % (digest, actual)
            ), None
        self.store_blob(session["name"], digest, data)
        location = "/v2/%s/blobs/%s" % (session["name"], digest)
        return 201, None, "", location

    def mount_blob(self, name, digest):
        """Cross-repo mount: the bytes are global, so a stored blob mounts."""
        if DIGEST_RE.match(digest) and self.has_blob_bytes(digest):
            self.store_blob(name, digest, b"")
            return True
        return False


class RegistryServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, registry):
        self.registry = registry
        super().__init__(address, RegistryHandler)


class RegistryHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # noqa: A003 - stdlib shape
        if os.environ.get("TXR_DEV_REGISTRY_QUIET"):
            return
        super().log_message(fmt, *args)

    # -- response helpers -----------------------------------------------------

    @property
    def registry(self):
        return self.server.registry

    def _api_headers(self, extra=None):
        combined = [("Docker-Distribution-API-Version", API_VERSION)]
        combined.extend(extra or [])
        return combined

    def _send(self, status, body=b"", headers=None):
        self.send_response(status)
        for key, value in headers or []:
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def _send_bytes(self, status, body, headers):
        self.send_response(status)
        for key, value in headers:
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_json(self, status, obj, extra=None):
        self._send_bytes(status, json.dumps(obj).encode("utf-8"),
                         self._api_headers([("Content-Type", "application/json")] + (extra or [])))

    def _send_error(self, status, code, message, extra=None):
        self._send_json(status, {"errors": [{"code": code, "message": message}]}, extra)

    def _read_body(self):
        te = (self.headers.get("Transfer-Encoding") or "").lower()
        if "chunked" in te:
            chunks = []
            while True:
                line = self.rfile.readline()
                size = int(line.strip().split(b";", 1)[0] or b"0", 16)
                if size == 0:
                    while self.rfile.readline().strip():
                        pass
                    break
                chunks.append(self.rfile.read(size))
                self.rfile.read(2)  # CRLF after each chunk
            return b"".join(chunks)
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def _send_blob(self, name, digest):
        path = self.registry.blob_path(digest)
        size = path.stat().st_size
        base_headers = self._api_headers([
            ("Content-Type", BLOB_CONTENT_TYPE),
            ("Docker-Content-Digest", digest),
            ("Accept-Ranges", "bytes"),
        ])
        range_header = self.headers.get("Range")
        if self.command in ("GET", "HEAD") and range_header:
            match = re.match(r"^bytes=(\d+)-(\d*)$", range_header.strip())
            if not match:
                self._send_error(416, "RANGE_INVALID", "unsupported Range: %r" % range_header,
                                 [("Content-Range", "bytes */%d" % size)])
                return
            start = int(match.group(1))
            end = int(match.group(2)) if match.group(2) else size - 1
            if start >= size or end < start or end >= size:
                self._send_error(416, "RANGE_INVALID",
                                 "requested range out of bounds: %r" % range_header,
                                 [("Content-Range", "bytes */%d" % size)])
                return
            length = end - start + 1
            self.send_response(206)
            for key, value in base_headers + [
                ("Content-Range", "bytes %d-%d/%d" % (start, end, size)),
                ("Content-Length", str(length)),
            ]:
                self.send_header(key, value)
            self.end_headers()
            if self.command != "HEAD":
                with open(path, "rb") as fh:
                    fh.seek(start)
                    remaining = length
                    while remaining:
                        chunk = fh.read(min(65536, remaining))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
            return
        self.send_response(200)
        for key, value in base_headers:
            self.send_header(key, value)
        self.send_header("Content-Length", str(size))
        self.end_headers()
        if self.command != "HEAD":
            with open(path, "rb") as fh:
                while True:
                    chunk = fh.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)

    def _send_manifest(self, name, ref):
        found = self.registry.read_manifest(name, ref)
        if found is None:
            self._send_error(404, "MANIFEST_UNKNOWN", "manifest unknown: %s" % ref)
            return
        body, media_type = found
        digest = "sha256:" + hashlib.sha256(body).hexdigest()
        self._send_bytes(200, body, self._api_headers([
            ("Content-Type", media_type),
            ("Docker-Content-Digest", digest),
        ]))

    # -- dispatch -------------------------------------------------------------

    def _dispatch(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path in ("/v2/", "/v2"):
            self._send_json(200, {})
            return
        if not path.startswith("/v2/"):
            self._send_error(404, "UNSUPPORTED", "unhandled path: %s" % path)
            return
        match = ROUTE_RE.match(path)
        if not match:
            self._send_error(404, "UNSUPPORTED", "unhandled path: %s" % path)
            return
        name = match.group("name")
        kind = match.group("kind")
        rest = match.group("rest") or ""
        if not self.registry.valid_name(name):
            self._send_error(400, "NAME_INVALID", "invalid repository name: %r" % name)
            return

        if kind == "tags/list":
            self._handle_tags_list(name, parsed.query)
            return
        if kind == "blobs":
            self._handle_blobs(name, rest, parsed.query)
            return
        if kind == "manifests":
            self._handle_manifests(name, rest, parsed.query, self.command)
            return
        self._send_error(404, "UNSUPPORTED", "unhandled path: %s" % path)

    def _handle_tags_list(self, name, query):
        if not self.registry.repo_dir(name).is_dir():
            self._send_error(404, "NAME_UNKNOWN", "repository name not known: %s" % name)
            return
        tags = self.registry.repo_tags(name)
        params = parse_qs(query)
        if "last" in params and params["last"][0]:
            tags = [t for t in tags if t > params["last"][0]]
        if "n" in params and re.match(r"^\d+$", params["n"][0]):
            tags = tags[: int(params["n"][0])]
        self._send_json(200, {"name": name, "tags": tags})

    def _handle_blobs(self, name, rest, query):
        method = self.command
        rest = rest.rstrip("/")
        if rest in ("", "uploads") and method == "POST":
            self._handle_blob_upload_start(name, query)
            return
        if rest.startswith("uploads/"):
            self._handle_blob_upload(name, rest[len("uploads/"):], query, method)
            return
        digest = rest
        if not self.registry.valid_digest(digest):
            self._send_error(400, "DIGEST_INVALID", "invalid blob digest: %r" % digest)
            return
        if not self.registry.repo_dir(name).is_dir():
            self._send_error(404, "NAME_UNKNOWN", "repository name not known: %s" % name)
            return
        if not self.registry.repo_has_blob(name, digest):
            self._send_error(404, "BLOB_UNKNOWN",
                             "blob unknown to %s: %s" % (name, digest))
            return
        if method in ("GET", "HEAD"):
            self._send_blob(name, digest)
            return
        self._send_error(405, "UNSUPPORTED", "method not supported on blobs: %s" % method)

    def _handle_blob_upload_start(self, name, query):
        params = parse_qs(query)
        mounted = params.get("mount", [None])[0]
        if mounted:
            if self.registry.valid_digest(mounted) and self.registry.mount_blob(name, mounted):
                self._send(201, b"", self._api_headers([
                    ("Docker-Content-Digest", mounted),
                    ("Location", "/v2/%s/blobs/%s" % (name, mounted)),
                ]))
                return
        data = self._read_body()
        session_id = self.registry.begin_upload(name, data)
        location = "/v2/%s/blobs/uploads/%s" % (name, session_id)
        self._send(202, b"", self._api_headers([
            ("Location", location),
            ("Docker-Upload-UUID", session_id),
            ("Range", "0-%d" % (len(data) - 1 if data else 0)),
        ]))

    def _handle_blob_upload(self, name, session_id, query, method):
        params = parse_qs(query)
        if method == "PATCH":
            data = self._read_body()
            size = self.registry.append_upload(session_id, data)
            if size is None:
                self._send_error(404, "BLOB_UPLOAD_UNKNOWN",
                                 "unknown upload session: %s" % session_id)
                return
            self._send(202, b"", self._api_headers([
                ("Location", "/v2/%s/blobs/uploads/%s" % (name, session_id)),
                ("Range", "0-%d" % (size - 1 if size else 0)),
            ]))
            return
        if method == "PUT":
            data = self._read_body()
            if data and not self.registry.append_upload(session_id, data):
                self._send_error(404, "BLOB_UPLOAD_UNKNOWN",
                                 "unknown upload session: %s" % session_id)
                return
            digest = params.get("digest", [None])[0]
            status, code, message, location = self.registry.finalize_upload(session_id, digest)
            if code is not None:
                self._send_error(status, code, message)
                return
            self._send(201, b"", self._api_headers([
                ("Location", location),
                ("Docker-Content-Digest", digest),
            ]))
            return
        self._send_error(405, "UNSUPPORTED", "method not supported on uploads: %s" % method)

    def _handle_manifests(self, name, ref, query, method):
        if method == "PUT":
            if not self.registry.valid_digest(ref) and not self.registry.valid_tag(ref):
                self._send_error(400, "DIGEST_INVALID",
                                 "invalid manifest reference: %r" % ref)
                return
            body = self._read_body()
            content_type = (self.headers.get("Content-Type")
                            or "application/vnd.oci.image.manifest.v1+json")
            digest, code, message = self.registry.put_manifest(name, ref, body, content_type)
            if code is not None:
                self._send_error(400, code, message)
                return
            self._send(201, b"", self._api_headers([
                ("Location", "/v2/%s/manifests/%s" % (name, ref)),
                ("Docker-Content-Digest", digest),
            ]))
            return
        if not self.registry.repo_dir(name).is_dir():
            self._send_error(404, "NAME_UNKNOWN", "repository name not known: %s" % name)
            return
        if not (self.registry.valid_digest(ref) or self.registry.valid_tag(ref)):
            self._send_error(400, "DIGEST_INVALID", "invalid manifest reference: %r" % ref)
            return
        if method == "DELETE":
            if self.registry.read_manifest(name, ref) is None:
                self._send_error(404, "MANIFEST_UNKNOWN", "manifest unknown: %s" % ref)
                return
            self.registry.delete_manifest(name, ref)
            self._send(202, b"", self._api_headers())
            return
        if method in ("GET", "HEAD"):
            self._send_manifest(name, ref)
            return
        self._send_error(405, "UNSUPPORTED", "method not supported on manifests: %s" % method)

    do_GET = _dispatch
    do_HEAD = _dispatch
    do_PUT = _dispatch
    do_POST = _dispatch
    do_PATCH = _dispatch
    do_DELETE = _dispatch


def main(argv=None):
    parser = argparse.ArgumentParser(description="TxResBench dev OCI registry (loopback)")
    parser.add_argument("--host",
                        default=os.environ.get("TXR_DEV_REGISTRY_HOST", DEFAULT_HOST),
                        help="bind host (default %s)" % DEFAULT_HOST)
    parser.add_argument("--port", type=int,
                        default=os.environ.get("TXR_DEV_REGISTRY_PORT", DEFAULT_PORT),
                        help="bind port (default %s)" % DEFAULT_PORT)
    parser.add_argument("--dir",
                        default=os.environ.get("TXR_DEV_REGISTRY_DIR", DEFAULT_DATA_DIR),
                        help="data directory (default %s)" % DEFAULT_DATA_DIR)
    args = parser.parse_args(argv)
    try:
        registry = DevRegistry(args.dir)
    except ValueError as exc:
        print("dev-registry: %s" % exc, file=sys.stderr)
        return 2
    try:
        server = RegistryServer((args.host, args.port), registry)
    except OSError as exc:
        print("dev-registry: cannot bind %s:%d: %s" % (args.host, args.port, exc),
              file=sys.stderr)
        return 2
    print("dev-registry: listening on %s:%d, data dir %s"
          % (args.host, args.port, registry.root), file=sys.stderr, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
