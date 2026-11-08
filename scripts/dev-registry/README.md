# dev-registry — TxResBench's local OCI registry + host-only publisher

The qa-hardening node's test infrastructure: everything the app's method-env
fetch needs, runnable on a developer box **without docker, without oras, without
network** — the whole stack is the host's own R/python plus these stdlib
python3 scripts.

| file | what it is |
|---|---|
| `registry.py` | the OCI distribution v2 server on loopback (ITEM-1) — the endpoint the app's fetch tool talks to instead of ghcr.io |
| `publish.py` | the host-only publisher: assembles the per-language base rootfs (R/python installs + shared-library closure), packs the per-method code layers, pushes both to `--registry`, writes the app's environment manifest |
| `oras_dev.py` | the minimal `oras` drop-in the app's fetch path needs (`resolve` + `pull --plain-http -o`) — no oras binary exists on the box and installing one is network use outside the owner's allowed scope |
| `acceptance.sh` | TEST-QA-2's driver: registry + fixture publish + the Rust acceptance test |
| `registry.test.py` / `publish.test.py` | TEST-QA-1 / TEST-QA-2 (publisher half) |

## Quick start (the acceptance run)

```sh
cd /data/pbya/txresbench-app-work/wt/feat-qa-hardening   # (your worktree)
TMPDIR=/data/pbya/txresbench-app-work/tmp-qa-hardening \
CARGO_TARGET_DIR=/data/pbya/txresbench-app-work/target/qa-hardening \
CAP_CPUS=2 /data/share/pbya/sigtrans/ops/cap.sh bash scripts/dev-registry/acceptance.sh
```

The driver starts the registry on an ephemeral port, publishes the fixture
artifact family (tiny base + tiny fake method), then runs the app-side Rust
test `sandbox::dev_registry_test` with the loopback registry seams set — the
app fetches, verifies, mounts and runs a published layer with real bwrap.

## The real-methods publish (six methods, both kinds)

```sh
# 1. start the registry (loopback default 127.0.0.1:5055)
TMPDIR=/data/pbya/txresbench-app-work/tmp-qa-hardening \
CAP_CPUS=2 /data/share/pbya/sigtrans/ops/cap.sh \
  python3 scripts/dev-registry/registry.py --port 5055 \
  --dir /data/pbya/txresbench-app-work/registry-data

# 2. build + push the base R / base Python rootfs and the six method layers
CAP_CPUS=2 /data/share/pbya/sigtrans/ops/cap.sh \
  python3 scripts/dev-registry/publish.py --registry 127.0.0.1:5055 \
  --out /data/pbya/txresbench-app-work/qa-build-real
```

Nothing above is written inside the git work tree: `--out` defaults to
`/data/pbya/txresbench-app-work/qa-build`, the registry data dir defaults to
`/data/pbya/txresbench-app-work/registry-data` (and the registry itself
refuses any path inside a git work tree).

The six methods (`publish.REAL_METHODS`) — runnable, in
`src-app/server/data/method-env-images.json`, covering both kinds:
`cfmedip-ctdna-clearance-three-group`, `cox-baseline-delta`,
`ctdna-clearance`, `ctdna-week4-rise-or-emergence`, `landmark-cox-current`,
`linear-response-score`.

## Start the app against it (debug builds only)

The app reaches the dev registry through the existing loopback registry-host
seam (`MethodEnvSeams::registry`), which this node wired to the process
environment in DEBUG builds only:

```sh
CONFIG_FILE=config/dev.yaml \
CYTO_TXR_METHOD_ENV_REGISTRY=127.0.0.1:5055 \
CYTO_TXR_ENV_MANIFEST=/data/pbya/txresbench-app-work/qa-build-real/method-env-images.dev.json \
cargo run
```

* `CYTO_TXR_METHOD_ENV_REGISTRY` — the HOST to fetch from instead of
  `ghcr.io`; the compiled `tinnlab/txresbench-env` and
  `tinnlab/txr-method-env-layers` namespaces/repos stay, so the published
  refs are exactly the app's refs. Read only under `#[cfg(debug_assertions)]`
  — a release build always fetches from `ghcr.io`.
* `CYTO_TXR_ENV_MANIFEST` — a schema-v1 environment manifest replacing the
  embedded `src-app/server/data/method-env-images.json` (the dev publisher's
  pins differ from the committed ghcr pins). The SAME validator runs,
  debug builds only.

Neither knob relaxes anything: digest verification stays ON (`ENV_VERIFY_FAILED`
on any mismatch), the run sandbox stays `--unshare-net`, and the release
binary has no code path that reads either variable.

## What the dev publisher does differently from the published pipeline

Visible, deliberate dev approximations (recorded in
`.lifecycle/txresbench-app/qa-hardening/DRIFT-1.md` ITEM-2):

1. **Base rootfs = the host install**, not a docker-built trimmed base. The
   host R 4.1.2 / python3.10 and their libraries are assembled with the
   shared-library closure so bwrap can run them. Method wrappers run against
   the HOST versions' API surface (the published base is R 4.4.2 / Py 3.11
   with pinned package versions).
2. **Layer = `/code` only.** The published generator computes a per-file
   docker delta over the benchmark base; the dev flow has neither, so the
   per-language stack lives in the base and the layer is the method's own
   wrapper bytes (`/code`, the schema marker, `/layer-manifest.json`, the
   `usr/` mount-readiness sentinel).
3. **`base_digest` = sha256 of the dev base squashfs** (the app's
   `EnvRef.digest` is a PAYLOAD-verify pin). The published manifest's
   `base_digest` is the benchmark base image's manifest digest (provenance).
4. The squashfs compressor is the recipe's (`-comp zstd -b 1M -all-root`)
   but the default zstd level (the recipe's 22 is a release choice).
