#!/usr/bin/env python3
"""floci-gcp-gcs-compat-proxy — a floci-gcp 0.7.0 GCS compatibility shim.

WHY THIS EXISTS (transparent, DEC-8):
  floci-gcp 0.7.0 stores + serves GCS object bytes correctly (bucket create,
  media/resumable/XML-single WRITE, ranged READ, list — all real), but its GCS
  responses OMIT the `ETag` and `Last-Modified` HTTP response headers. Rust's
  `object_store` 0.13.2 GCP backend (the client the product's native-GCS `S3Store`
  is built on) STRUCTURALLY requires those headers to parse object metadata, so
  every object_store GCS op fails against vanilla floci-gcp 0.7.0 with
  "ETag Header missing" / "Last-Modified Header missing".

  Those two headers are HTTP plumbing the TxResBench workstore NEVER consults —
  the workstore is CONTENT-ADDRESSED (sha256:<hex> of the bytes); it does not use
  etag/last-modified for correctness. So this shim is a faithful compatibility
  adapter, NOT a mock of storage: floci-gcp still stores and serves every real
  byte; the shim only surfaces the structurally-required headers object_store
  needs to parse the response. The object bytes and content-addressed keys are
  100% real and validated by the contract.

  It is a stopgap for the emulator's gap, documented as such. A floci-gcp release
  that emits standard GCS metadata headers makes this shim unnecessary (point
  STORAGE_EMULATOR_HOST straight at :4588).

Loopback-only, stdlib-only (no pip deps), credential-free.
"""
import email.utils
import json
import os
import sys
import urllib.parse
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = os.environ.get("FLOCI_GCP_UPSTREAM", "http://127.0.0.1:4588")
LISTEN_PORT = int(os.environ.get("TXR_FLOCI_GCP_COMPAT_PORT", "4599"))
# Bind host — LOOPBACK-ONLY by default (DE-INV-13). A pod-facing deployment (a k8s
# worker reaching the shim over the CNI bridge, not host loopback) may set
# TXR_FLOCI_GCP_COMPAT_BIND=0.0.0.0 to expose it on the bridge; keep the 127.0.0.1
# default everywhere else so the loopback-only invariant holds for the test tiers.
LISTEN_HOST = os.environ.get("TXR_FLOCI_GCP_COMPAT_BIND", "127.0.0.1")
# A fixed, valid HTTP-date + strong ETag. Values are irrelevant to the
# content-addressed workstore; they exist only so object_store can PARSE.
FIXED_LAST_MODIFIED = email.utils.formatdate(0, usegmt=True)
FIXED_ETAG = '"txr-floci-gcp-compat"'
HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade",
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass  # quiet

    def _proxy(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length) if length else None
        # object_store lists via the S3-style XML ListObjectsV2 API
        # (GET /{bucket}?list-type=2&prefix=…), which floci-gcp 0.7.0 does not implement
        # (405). Translate it to floci-gcp's GCS-JSON list and synthesize the S3 XML
        # ListBucketResult object_store expects. (The listed objects are all REAL.)
        if self.command == "GET" and self._try_list_translation():
            return
        # object_store deletes via the XML API (DELETE /{bucket}/{object}), which floci-gcp
        # 0.7.0 answers 405; translate to the GCS-JSON object-delete it does implement.
        if self.command == "DELETE" and self._try_delete_translation():
            return
        url = UPSTREAM + self.path
        req = urllib.request.Request(url=url, data=body, method=self.command)
        for k, v in self.headers.items():
            if k.lower() in HOP_BY_HOP or k.lower() == "host":
                continue
            req.add_header(k, v)
        try:
            resp = urllib.request.urlopen(req, timeout=120)
            status, resp_headers, payload = resp.status, resp.headers, resp.read()
        except urllib.error.HTTPError as e:
            status, resp_headers, payload = e.code, e.headers, e.read()
        except Exception as e:  # noqa: BLE001
            self.send_error(502, f"floci-gcp compat proxy upstream error: {e}")
            return

        # Is this a GCS object/bucket response? (inject on all storage paths.)
        inject = self.path.startswith("/storage/") or self.path.startswith("/upload/") \
            or self.path.startswith("/download/") or ("/o/" in self.path) \
            or self._looks_like_xml_object()

        is_head = self.command == "HEAD"
        out = {}
        upstream_clen = None
        for k, v in resp_headers.items():
            if k.lower() in HOP_BY_HOP:
                continue
            if k.lower() == "content-length":
                upstream_clen = v
                continue
            out[k] = v
        if inject:
            if not any(k.lower() == "etag" for k in out):
                out["ETag"] = FIXED_ETAG
            if not any(k.lower() == "last-modified" for k in out):
                out["Last-Modified"] = FIXED_LAST_MODIFIED

        self.send_response(status)
        for k, v in out.items():
            self.send_header(k, v)
        # For HEAD there is no body to measure. object_store `stat`/`head` reads the object
        # size from the response Content-Length — but floci-gcp 0.7.0's XML HEAD omits it
        # entirely. Backfill it from the JSON metadata `size` field (the size IS real; only
        # the header is missing). For every other method, send the true body length.
        if is_head:
            clen = upstream_clen
            if clen is None and status == 200:
                clen = self._object_size_via_json()
            if os.environ.get("TXR_FLOCI_GCP_COMPAT_DEBUG"):
                print(f"[compat] HEAD {self.path} status={status} "
                      f"upstream_clen={upstream_clen} resolved_clen={clen}",
                      file=sys.stderr, flush=True)
            self.send_header("Content-Length", clen if clen is not None else "0")
        else:
            self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if not is_head:
            self.wfile.write(payload)

    def _try_delete_translation(self):
        """Translate an S3-style XML object delete (`DELETE /{bucket}/{object}`) to the
        GCS-JSON object delete floci-gcp implements. Returns True if handled."""
        raw_path = self.path.split("?", 1)[0].strip("/")
        if "/" not in raw_path or raw_path.startswith(
                ("storage", "upload", "download", "container", "iam", "b/")):
            return False
        bucket_enc, obj_enc = raw_path.split("/", 1)
        bucket = urllib.parse.unquote(bucket_enc)
        obj = urllib.parse.unquote(obj_enc)
        jurl = "%s/storage/v1/b/%s/o/%s" % (
            UPSTREAM, urllib.parse.quote(bucket, safe=""),
            urllib.parse.quote(obj, safe=""))
        req = urllib.request.Request(url=jurl, method="DELETE")
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                status = r.status
        except urllib.error.HTTPError as e:
            status = e.code
        except Exception as e:  # noqa: BLE001
            self.send_error(502, f"compat delete-translate upstream error: {e}")
            return True
        if os.environ.get("TXR_FLOCI_GCP_COMPAT_DEBUG"):
            print(f"[compat] DELETE {obj} → json status={status}", file=sys.stderr, flush=True)
        # object_store treats 204/200/404 as a successful (idempotent) delete.
        self.send_response(204 if status in (200, 204, 404) else status)
        self.send_header("Content-Length", "0")
        self.end_headers()
        return True

    def _try_list_translation(self):
        """If this GET is an S3 ListObjectsV2 (`/{bucket}?list-type=2`), serve it by
        translating floci-gcp's GCS-JSON list into the S3 XML ListBucketResult
        object_store parses. Returns True if handled.

        LIMITATION (honest): this translates the FLAT prefix listing the workstore's
        `gc` uses (`prefix=blobs/`, continuation-token pagination). It does NOT
        translate `delimiter`/`CommonPrefixes` (hierarchical listing) or forward
        `max-keys`→`maxResults` (page size is floci-gcp's JSON default). The workstore
        never issues a delimited list, so this is sufficient for the contract; a
        consumer that needs delimited listing would require extending this."""
        split = self.path.split("?", 1)
        raw_path = split[0].strip("/")
        query = urllib.parse.parse_qs(split[1]) if len(split) > 1 else {}
        if "/" in raw_path or "list-type" not in query:
            return False
        bucket_enc = raw_path
        bucket = urllib.parse.unquote(bucket_enc)
        prefix = query.get("prefix", [""])[0]
        cont = query.get("continuation-token", [None])[0]
        url_encode = query.get("encoding-type", [""])[0] == "url"
        # Fetch one JSON page from floci-gcp (map continuation-token ↔ pageToken).
        q = {"prefix": prefix} if prefix else {}
        if cont:
            q["pageToken"] = cont
        jurl = "%s/storage/v1/b/%s/o" % (UPSTREAM, urllib.parse.quote(bucket, safe=""))
        if q:
            jurl += "?" + urllib.parse.urlencode(q)
        try:
            with urllib.request.urlopen(jurl, timeout=60) as r:
                meta = json.loads(r.read() or b"{}")
        except Exception as e:  # noqa: BLE001
            self.send_error(502, f"compat list-translate upstream error: {e}")
            return True
        items = meta.get("items", []) or []
        next_token = meta.get("nextPageToken")

        def esc(s):
            return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))

        def key_out(name):
            return esc(urllib.parse.quote(name, safe="") if url_encode else name)

        parts = ['<?xml version="1.0" encoding="UTF-8"?>',
                 '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
                 f"<Name>{esc(bucket)}</Name>",
                 f"<Prefix>{key_out(prefix)}</Prefix>",
                 f"<KeyCount>{len(items)}</KeyCount>",
                 "<MaxKeys>1000</MaxKeys>"]
        if url_encode:
            parts.append("<EncodingType>url</EncodingType>")
        parts.append(f"<IsTruncated>{'true' if next_token else 'false'}</IsTruncated>")
        if next_token:
            parts.append(f"<NextContinuationToken>{esc(next_token)}</NextContinuationToken>")
        for it in items:
            etag = it.get("etag") or it.get("md5Hash") or "txr-floci-gcp-compat"
            parts.append(
                "<Contents>"
                f"<Key>{key_out(it.get('name',''))}</Key>"
                f"<LastModified>{esc(it.get('updated', '1970-01-01T00:00:00.000Z'))}</LastModified>"
                f'<ETag>"{esc(etag)}"</ETag>'
                f"<Size>{esc(str(it.get('size', '0')))}</Size>"
                "<StorageClass>STANDARD</StorageClass>"
                "</Contents>")
        parts.append("</ListBucketResult>")
        payload = "".join(parts).encode("utf-8")
        if os.environ.get("TXR_FLOCI_GCP_COMPAT_DEBUG"):
            print(f"[compat] LIST bucket={bucket} prefix={prefix!r} items={len(items)} "
                  f"truncated={bool(next_token)}", file=sys.stderr, flush=True)
        self.send_response(200)
        self.send_header("Content-Type", "application/xml")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
        return True

    def _object_size_via_json(self):
        """Resolve an object's real byte size from floci-gcp's JSON metadata (`size`),
        for a HEAD whose upstream response carried no Content-Length. Returns a str or None."""
        path = self.path.split("?", 1)[0].strip("/")
        # Normalize both the XML path (/{bucket}/{object}) and the JSON path
        # (/storage/v1/b/{bucket}/o/{object}) to (bucket, object).
        if path.startswith("storage/v1/b/") and "/o/" in path:
            rest = path[len("storage/v1/b/"):]
            bucket, obj = rest.split("/o/", 1)
        elif "/" in path and not path.startswith(("storage", "upload", "download",
                                                  "container", "iam")):
            # XML path `/{bucket}/{object}` — object_store percent-encodes BOTH the bucket
            # and the object (its '/' → %2F) as two segments joined by one literal '/'.
            bucket, obj = path.split("/", 1)
        else:
            return None
        # The split parts are still percent-encoded — decode before re-quoting for the lookup.
        bucket = urllib.parse.unquote(bucket)
        obj = urllib.parse.unquote(obj)
        url = "%s/storage/v1/b/%s/o/%s" % (
            UPSTREAM, urllib.parse.quote(bucket, safe=""),
            urllib.parse.quote(obj, safe=""))
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                meta = json.loads(r.read())
            return str(meta.get("size")) if meta.get("size") is not None else None
        except Exception:  # noqa: BLE001
            return None

    def _looks_like_xml_object(self):
        # XML-API single-object path: /{bucket}/{object} (not /storage, /upload …).
        p = self.path.split("?", 1)[0].strip("/")
        return "/" in p and not p.startswith(("storage", "upload", "download",
                                              "container", "iam", "b/"))

    do_GET = _proxy
    do_PUT = _proxy
    do_POST = _proxy
    do_DELETE = _proxy
    do_HEAD = _proxy
    do_PATCH = _proxy


def main():
    srv = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    print(f"[floci-gcp-compat] listening on {LISTEN_HOST}:{LISTEN_PORT} → {UPSTREAM} "
          f"(injecting ETag/Last-Modified for object_store)", file=sys.stderr, flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
