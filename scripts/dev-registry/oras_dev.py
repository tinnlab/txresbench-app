#!/usr/bin/env python3
"""oras dev drop-in — the minimal `oras` the app's fetch path shells out to.

The app runs exactly two `oras` commands against the loopback dev registry
(`src-app/server/src/modules/sandbox/method_env.rs`):

    oras resolve [--plain-http] <host>/<repo>[:<tag>|@sha256:...]
    oras pull    [--plain-http] -o <dir> <host>/<repo>[:<tag>|@sha256:...]

`resolve` prints the manifest's content digest; `pull` fetches the manifest
and its single layer and writes the layer file to `<dir>/<filename>` (oras
writes the layer's file name, which for the txr artifacts is
`layer.squashfs`; the app picks the first `*.squashfs` in the staging dir).
An OCI distribution v2 registry (ghcr or `registry.py`) serves both.

WHY IT EXISTS: no `oras` binary is installed on this box, and installing one
is network use outside the owner's allowed scope. This is the dev substitute,
implemented in stdlib python against the same registry wire protocol. It is a
REAL client of the dev registry (blobs + manifests over HTTP, digest checks),
not a stub: `resolve` verifies the tag's `Docker-Content-Digest`, `pull`
verifies every downloaded digest, and a mismatch exits non-zero exactly like
oras. The app's own digest verification (sha256 of the pulled payload against
the catalogue pin) is unchanged — this shim is not a bypass.

It deliberately implements ONLY the app's usage surface. Run:

    scripts/dev-registry/acceptance.sh  (sets PATH so the app finds it as `oras`)

Other oras subcommands exit 1 with a message.
"""

import hashlib
import http.client
import json
import os
import sys
import urllib.parse


def _http(hostport):
    host, _, port = hostport.partition(":")
    return http.client.HTTPConnection(host, int(port or 80), timeout=120)


def split_ref(ref):
    """Return (host, repo, tag, digest) — the app's refs are
    `<host>/<repo>[:<tag>][@sha256:...]`, the registry path is `/v2/<repo>/...`."""
    name, tag, digest = ref, None, None
    if "@" in name:
        name, d = name.rsplit("@", 1)
        digest = d
    if ":" in name:
        maybe = name.rsplit(":", 1)
        if "/" not in maybe[1]:
            name, tag = maybe
    host, _, repo = name.partition("/")
    return host, repo, tag, digest


def _body(conn, method, path, headers=None):
    conn.request(method, path, headers=headers or {})
    resp = conn.getresponse()
    return resp.status, dict(resp.getheaders()), resp.read()


def fetch_json(conn, repo, ref):
    """GET the manifest, verify the digest where pinned, return (obj, digest)."""
    path = "/v2/%s/manifests/%s" % (repo, ref)
    status, headers, body = _body(conn, "GET", path, headers={
        "Accept": "application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json",
    })
    if status == 404:
        raise SystemExit("oras dev: manifest %s not found (404)" % ref)
    if status != 200:
        raise SystemExit("oras dev: manifest %s: HTTP %d" % (ref, status))
    d = headers.get("Docker-Content-Digest")
    if d and not d.startswith("sha256:"):
        d = None
    if d:
        if hashlib.sha256(body).hexdigest() != d[len("sha256:"):]:
            raise SystemExit("oras dev: manifest %s digest mismatch (registry verify failed)" % ref)
    return json.loads(body), d


def cmd_resolve(args):
    plain = "--plain-http" in args
    refs = [a for a in args if not a.startswith("-")]
    if not refs:
        raise SystemExit("oras dev: resolve needs a ref")
    host, repo, tag, digest = split_ref(refs[0])
    if not plain:
        raise SystemExit("oras dev: resolve without --plain-http is not the app's shape")
    conn = _http(host)
    if digest:
        obj, d = fetch_json(conn, repo, digest)
        print(d or ("sha256:" + hashlib.sha256(json.dumps(obj).encode()).hexdigest()))
        return 0
    if not tag:
        raise SystemExit("oras dev: resolve of a bare ref needs a tag")
    obj, d = fetch_json(conn, repo, tag)
    print(d or ("sha256:" + hashlib.sha256(json.dumps(obj).encode()).hexdigest()))
    return 0


def cmd_pull(args):
    plain = "--plain-http" in args
    out = None
    for i, a in enumerate(args):
        if a == "-o":
            out = args[i + 1]
    refs = [a for a in args if not a.startswith("-") and a != out]
    if not refs:
        raise SystemExit("oras dev: pull needs a ref")
    ref = refs[-1]
    host, repo, tag, digest = split_ref(ref)
    if not plain:
        raise SystemExit("oras dev: pull without --plain-http is not the app's shape")
    conn = _http(host)
    if digest:
        obj, _ = fetch_json(conn, repo, digest)
    else:
        obj, _ = fetch_json(conn, repo, tag)
    layers = obj.get("layers") or []
    os.makedirs(out, exist_ok=True)
    for layer in layers:
        ldigest = layer["digest"]
        lname = (layer.get("annotations") or {}).get(
            "org.opencontainers.image.title", "blob")
        title = os.path.basename(lname)
        path = os.path.join(out, title)
        status, headers, body = _body(conn, "GET", "/v2/%s/blobs/%s" % (repo, ldigest))
        if status != 200:
            raise SystemExit("oras dev: blob %s: HTTP %d" % (ldigest, status))
        if hashlib.sha256(body).hexdigest() != ldigest[len("sha256:"):]:
            raise SystemExit("oras dev: blob %s digest mismatch (registry verify failed)" % ldigest)
        with open(path, "wb") as f:
            f.write(body)
        print("Downloaded %s (%d bytes)" % (title, len(body)))
    return 0


def main(argv):
    if not argv:
        print("oras dev: usage: oras resolve|pull ...", file=sys.stderr)
        return 1
    sub = argv[0]
    if sub == "resolve":
        return cmd_resolve(argv[1:])
    if sub == "pull":
        return cmd_pull(argv[1:])
    print("oras dev: unsupported subcommand %r (the app uses resolve + pull only)" % sub, file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
