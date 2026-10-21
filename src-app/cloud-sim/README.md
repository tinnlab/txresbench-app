# Local cloud-sim substrate (epic `compute-storage`, item **T1**)

The **portability oracle** + the dev/CI substrate every downstream compute item
(T2 object-store, T3 worker, T4 multi-worker/KEDA) is built and tested against.
It runs the **actual** cloud implementations locally at small scale — this is
*not* mocking: **floci** is a real S3 server, **floci-gcp** speaks the **native**
GCS API, and both spin up a real **k3s** node (EKS→k3s / GKE→k3s). An
`ObjectStore` body or a worker Deployment that passes here would run unchanged on
AWS S3 / GCS / EKS / GKE.

> **Design source.** Realizes `cloud-elastic-compute.md` **§12a** (local cloud
> simulation) + **§14 Step-1a**, and makes **DE-INV-13** machine-checkable. That
> design doc lives on the unmerged research branch `design/cloud-elastic-compute`
> (research branches stay unmerged); this README carries the §12a *build-items*
> cross-reference in-tree so the substrate is documented where it ships.

## The substrate: floci (AWS) + floci-gcp (GCP)

The cloud-sim substrate is standardized on two credential-free local emulators,
each backing one cloud half. Both are real implementations, not mocks.

| Half | Storage | Compute k8s | Script |
|---|---|---|---|
| **floci** (AWS) | S3 on `:4566` | EKS → real k3s node | `scripts/cloud-sim-floci.sh` |
| **floci-gcp** (GCP) | GCS on `:4588` (native reads + single-blob writes) | GKE → real k3s node | `scripts/cloud-sim-floci-gcp.sh` |

## Recipes

```bash
just cloud-sim-floci-up           # AWS half: floci S3 on :4566, canonical bucket pre-created,
                                  #           env contract written to .floci-sim.env
just cloud-sim-floci-down         # tear the floci S3/EKS stack down (idempotent)
just cloud-sim-floci-gcp-up       # GCP half: floci-gcp GCS on :4588 (+ compat shim), env → .floci-gcp-sim.env
just cloud-sim-floci-gcp-down     # tear the floci-gcp GCS/GKE stack down (idempotent)
just cloud-sim-test-floci-gcs     # GCS ACCEPTANCE tier: guard → up → native-GCS contract legs → down
just cloud-sim-test-floci-k8s     # AWS k8s tier: guard → up → EKS→k3s → KubernetesBackend contract → down
just cloud-sim-load-image <img>   # image load onto the k3s node (no registry: docker save | ctr images import)
```

Both `up` recipes are **idempotent** (re-run is a no-op on a live stack + an
existing bucket) and **credential-free** (only static dummy creds; no cloud
account).

> **Concurrent runs on a shared box.** The two halves use fixed host ports
> (floci S3 `:4566`, floci-gcp GCS `:4588` + compat shim `:4599`) and fixed
> container names; two simultaneous `up`s of the same half collide and the second
> fails loudly. To run in parallel, override the ports/names via the
> `CYTO_FLOCI_*` / `CYTO_FLOCI_GCP_*` env vars each script documents.

## The endpoint-override env contract (**PROV-T1-4**)

`cloud-sim-floci-up` / `cloud-sim-floci-gcp-up` write these to
`src-app/cloud-sim/.floci-sim.env` / `.floci-gcp-sim.env` (both gitignored);
source one (`set -a; source src-app/cloud-sim/.floci-sim.env; set +a`) to point a
backend at that half of the sim:

| var | sim value | meaning |
|---|---|---|
| `CYTO_WORKSTORE_BACKEND` | `s3` / `gcs` | select the object-store backend for the half |
| `S3_ENDPOINT` | `http://127.0.0.1:4566` | floci S3 API (loopback) |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `cyto-sim` / `cyto-sim-secret` | **static dummy** creds |
| `AWS_REGION` | `us-east-1` | region (nominal) |
| `STORAGE_EMULATOR_HOST` | `http://127.0.0.1:4599` | the floci-gcp GCS **compat shim** (see below) |
| `GOOGLE_CLOUD_PROJECT` | `floci-local` | dummy GCP project id |
| `CYTO_WORKSTORE_S3_BUCKET` | `cyto-worklab` | the canonical bucket, **pre-created** |
| `CYTO_COMPUTE_BACKEND` | `kubernetes` | select the k8s compute backend |
| `KUBECONFIG` | `src-app/cloud-sim/.floci-kube-config` | the sim cluster kubeconfig |

**Release posture (DEC-6).** The loopback endpoint overrides (`S3_ENDPOINT`,
`STORAGE_EMULATOR_HOST`) are **debug-only test seams** — the backend code T2/T3
add must honor them only under `#[cfg(debug_assertions)]`, exactly like the
existing `EnvImageSeams`. A release binary ignores a loopback redirect.

## The no-cloud-credentials guard (**PROV-T1-5**, DE-INV-13)

`scripts/cloud-sim-guard.sh` runs **first** in every tier and FAILS the run if a
real cloud credential or a non-loopback endpoint is present: `AWS_PROFILE`,
`AWS_ROLE_ARN` / `AWS_WEB_IDENTITY_TOKEN_FILE` (IRSA), `GOOGLE_APPLICATION_CREDENTIALS`,
an `AKIA…`/`ASIA…` access key, a non-loopback `S3_ENDPOINT` / `AWS_ENDPOINT*` /
`STORAGE_EMULATOR_HOST`, or a reachable instance-metadata service. Every
downstream tier inherits the guarantee. `bash scripts/cloud-sim-guard.sh
--selftest` proves it passes clean and fails on a planted cred.

## Host requirements

- **Storage legs:** `docker`, `curl`, and `python3` (the GCS compat shim), plus
  the dev Postgres cluster for tests that need it (`cd src-app && docker compose up -d`).
- **Compute k8s legs:** additionally the `aws` CLI (floci EKS→k3s), `kubectl`,
  `helm`, and unprivileged user namespaces enabled for the Docker-backed k3s node.
  Missing tools **hard-fail with remediation** (loud-skip contract) — never a
  silent skip.

## Honest real-cloud-only gaps

The sim is a faithful API oracle, not a full cloud. It does **not** exercise:
IAM/role boundaries + STS, real S3/GCS eventual-consistency + throttling,
cross-AZ latency + partitions, cloud-provider quotas/billing, real node
autoscaling (cluster-autoscaler / Karpenter — KEDA scales *pods*, not nodes),
or provider-specific object-lifecycle features. Those remain real-cloud-only and
are validated out-of-band.

## floci-gcp GCS compat shim (honest note)

floci-gcp serves the native-GCS **read** path and the single-blob **write** path
directly on `:4588` and stores/serves the real object bytes. But floci-gcp
**0.7.0** omits two things Rust `object_store` **0.13.2** requires: the `ETag` /
`Last-Modified` HTTP response headers, and the S3-XML `list`/`delete` verbs. So
`scripts/floci-gcp-gcs-compat-proxy.py` sits in front on **:4599** and reconciles
exactly those — it synthesizes the missing headers and translates the list/delete
verbs, while floci-gcp still stores and serves the real bytes. The env contract
therefore points `STORAGE_EMULATOR_HOST` at the shim (`http://127.0.0.1:4599`),
with `GOOGLE_CLOUD_PROJECT=floci-local` and the usual `CYTO_WORKSTORE_S3_BUCKET` /
`KUBECONFIG`. Set `CYTO_FLOCI_GCP_COMPAT_PORT=0` to bypass the shim once floci-gcp
emits the standard headers/verbs itself.

> **GCS multipart write stays real-GCS-only.** floci-gcp 0.7.0 does not implement
> the GCS XML-multipart API, so the native-GCS *multipart* write leg of
> `s3_contract_test.rs` self-skips on the emulator and runs only against real GCS.
> The single-blob GCS write path IS proven on floci-gcp.

Each script (floci = S3+EKS, floci-gcp = GCS+GKE) also exposes `env`, `bucket`,
`smoke`, its `*-up`/`*-down` compute subcommands, and the `contract-*` acceptance
tiers. Both are **idempotent** and **credential-free** (static dummy creds,
loopback-only) and run `cloud-sim-guard.sh` **first** in every test tier — so a
green run is a real portability proof. Every container each starts (`cyto-floci`
plus its `floci-eks-*`/`floci-ecr-*` siblings; the floci-gcp container plus its
GKE k3s sibling) is swept on teardown. The Docker images need the host
`/var/run/docker.sock` to spawn their k3s siblings for EKS/GKE.

## Retired substrate (RETIRED-SUBSTRATE)

> Historical only — the substrate described in this section is RETIRED and
> replaced by floci + floci-gcp above.

- The old Level-1 storage substrate was `minio` (S3) + `fake-gcs-server` (GCS) via a docker-compose stack. RETIRED-SUBSTRATE
- The old Level-2 compute substrate was `kind` / `k3d` + KEDA + a worker Deployment. RETIRED-SUBSTRATE
- `fake-gcs-server` could not serve the native-GCS write path — that is why floci-gcp now backs GCS. RETIRED-SUBSTRATE
- Image load used `kind load` / `k3d image import`; the k3s node now uses `docker save | ctr images import`. RETIRED-SUBSTRATE

## Deploying the worker (reproducible runbook) — deploy-hardening (#67)

CELL-1 proved the worker-pod compute path runs a real analysis end-to-end against
S3 on real k3s. These are the committed fixes that make that deployment
**reproducible** — the 5 gaps CELL-1 had to fix by hand.

> **Deploying to a REAL cloud (AWS / GCP)?** This section covers the emulator
> substrate. For real S3/GCS buckets, real EKS/GKE clusters, least-privilege IAM,
> IRSA / Workload Identity, ECR / Artifact Registry, and the cross-provider
> pairings, follow **[`REAL-CLOUD-RUNBOOK.md`](REAL-CLOUD-RUNBOOK.md)** — the
> step-by-step operator procedure for the storage×compute matrix (#67). It marks
> every claim VERIFIED / INFERRED / VERIFY-AT-PROVISIONING and records the two
> credential-chain gaps a real deployment hits (IRSA and GCP workload-identity
> federation are NOT reachable by the pinned `object_store` client today).

### 1. Build the worker image HERMETICALLY (gap #1)

Every crate's `build.rs` — the app's `provision_build_db` AND the FROZEN SDK crates
(ziee-auth / ziee-file / ziee-seed / ziee-notification / ziee-onboarding) — provisions
a per-worktree sqlx **build database** on `127.0.0.1:54321` and PANICS if it cannot
connect; none honor `SQLX_OFFLINE`. Because the SDK pin is frozen, an offline `.sqlx`
cache cannot make the build hermetic (the SDK scripts would still connect and panic).
So `worker.Dockerfile` stands up its **own** throwaway Postgres inside the builder
stage. Build from a **clean checkout, at the repo root**, with the one command:

```bash
just cloud-sim-worker-build            # → cyto-sim-worker:dev  (no host DB, no editing)
# equivalently:  docker build -f src-app/cloud-sim/worker.Dockerfile -t cyto-sim-worker:dev .
```

### 2. Load the image onto the cluster — including floci's k3s (gap #5)

```bash
just cloud-sim-load-image cyto-sim-worker:dev
```

The image load targets the floci / floci-gcp Docker-backed **k3s** node. It uses
the route CELL-1 used — `docker save | ctr images import` into the k3s node's
containerd. The node is discovered by floci's `floci-eks-*` (or floci-gcp's GKE)
container name; override with `CYTO_CLOUD_SIM_K3S_NODE`.

### 3. Boot config — a mounted Secret file (gap #2)

`ServerConfig::load()` reads ONE YAML via `CONFIG_FILE`; it does **not** read a
`DATABASE_URL`/env for the Postgres + jwt + at-rest-secret key, so the worker exited
"no config file found" as originally shipped. Ship the config as a **Secret file** (it
carries the PG password + jwt.secret + storage_key, so it belongs in a Secret, not a
ConfigMap) and point `CONFIG_FILE` at it:

```bash
# edit the CHANGE_ME values first (external PG host/user/pw, jwt.secret, storage_key):
kubectl apply -f src-app/cloud-sim/worker-config.example.yaml
# object-store env (static creds + bucket + optional rootfs ref):
kubectl create secret generic cyto-worker-env \
  --from-literal=CYTO_WORKSTORE_S3_BUCKET=cyto-worklab \
  --from-literal=AWS_ACCESS_KEY_ID=... --from-literal=AWS_SECRET_ACCESS_KEY=... \
  --from-literal=AWS_REGION=us-east-1
kubectl apply -f src-app/cloud-sim/worker-deployment.scaffold.yaml
```

The scaffold mounts the Secret at `/etc/cytoanalyst/config.yaml` and sets `CONFIG_FILE`,
so the worker boots with **no hand-editing** beyond filling the two Secrets.

### 4. A custom S3 endpoint in a RELEASE worker → the DB, not env (gap #3)

The debug `S3_ENDPOINT` env seam is **debug-only by design** (`endpoint_seam` gates it
on `debug_assertions`), so a `--release` worker IGNORES it — it must not silently hit
real AWS. For production with a CUSTOM S3-compatible endpoint (floci, a private
object store, a non-default region), configure the endpoint/bucket/creds via the **DB
`infra_object_store` row (#63)** through the admin API — which IS release-safe: the boot
path (`resolve_effective_object_store` → `merge_s3_conn`) layers the DB endpoint over env
with **no** debug gate (verified + pinned by
`workstore/config.rs::release_worker_reads_custom_endpoint_from_db_infra_config`).

```bash
# via the admin API (requires infra::settings::manage + secrets.storage_key set):
curl -X PUT https://<api>/api/admin/infra/object-store -H 'Authorization: Bearer <admin>' \
  -d '{"backend":"s3","endpoint":"https://objstore.internal:9000","bucket":"prod-worklab",
       "region":"eu-west-1","path_style":true,"access_key_id":"...","secret_access_key":"..."}'
```

Use the debug env seam (`S3_ENDPOINT` + `AWS_*` from `.floci-sim.env`/`.cloud-sim.env`)
ONLY with a **debug** build against the emulator; use the DB infra config for a release
deploy to a custom endpoint. The scaffold supports both.

### 5. securityContext — squashfuse needs /dev/fuse (gap #4)

The scaffold ships `securityContext.privileged: true` — the simple path CELL-1 proved
works. squashfuse (the env-rootfs mount) needs `/dev/fuse`; **bwrap's unprivileged user
namespaces need NO privilege — only fuse does**. For least-privilege production, drop
`privileged` and expose `/dev/fuse` via a **fuse-device-plugin** instead (deploy the
plugin, then request `github.com/fuse: 1` under the container's `resources.limits`). That
keeps the pod unprivileged while still giving squashfuse its device.

### 6. env-rootfs delivery (gap #5)

The image ships no `oras`/`cosign` and GHCR is private, so the worker cannot pull the
env-rootfs squashfs itself. The scaffold delivers it via an **initContainer** into a
shared `env-rootfs` volume, writing exactly the file the worker's
`CYTO_ENV_ROOTFS_SQUASHFS` path (`/var/lib/cytoanalyst/env-rootfs/rootfs.squashfs`,
release-safe air-gap seam 1) expects; `CYTO_SANDBOX_ENV_ID` sets the deployment-default
env-id. Replace the initContainer's `image` + `args` with your real fetch (an oras image
using a `read:packages` token from the Secret, an internal mirror, or a curl). The shipped
initContainer is a deliberately-failing placeholder (it `exit 1`s until it delivers the file), so
the pod stays in `Init` until you choose a delivery — this is the ONE required decision.

**Alternative — bake the squashfs into the worker image:** add the documented `COPY` line in
`worker.Dockerfile` (needs the file in the build context), then in the scaffold **delete all
three** of: the `fetch-env-rootfs` initContainer, the `env-rootfs` volume, AND the worker's
`env-rootfs` `volumeMount`. Leaving the `env-rootfs` volume mounted at
`/var/lib/cytoanalyst/env-rootfs` would shadow the baked file with an empty dir — so the mount
must be removed when baking, not just the initContainer.

### 7. pod→S3 networking — the CNI bridge IP, not 127.0.0.1

A pod reaching an object store / DB that runs on the **host** must use the **CNI bridge
IP** (the cluster node/bridge address), never `127.0.0.1` — loopback inside a pod is the
pod itself. Point `S3_ENDPOINT` (debug/emulator) or the DB `endpoint` (release) and the
external PG `host` at the bridge address, not loopback.

### Validate before deploying

```bash
bash src-app/cloud-sim/tests/validate-manifests.sh      # kubectl dry-run + wiring self-consistency
bash src-app/cloud-sim/tests/hermetic-build-check.sh    # build wiring (add --full for a real build)
```

## Files

- `REAL-CLOUD-RUNBOOK.md` — the REAL-cloud operator runbook (#67): least-privilege IAM for
  S3/GCS, EKS/GKE + IRSA/Workload-Identity, ECR/Artifact-Registry, the production
  object-store config path, the smoke checklist, the 4 matrix pairings (incl. what
  cross-provider auth actually requires) and a troubleshooting table.
- `docker-compose.cloud-sim.yaml` — RETIRED-SUBSTRATE: the old Level-1 emulators (historical stub).
- `kind-config.yaml` — RETIRED-SUBSTRATE: the old Level-2 kind cluster config (historical).
- `keda-scaledobject.yaml` — the queue-depth ScaledObject (reads `jobs.status='queued'`).
- `worker.Dockerfile` — the hermetically-buildable `cytoanalyst worker` image (gap #1/#5).
- `worker-deployment.scaffold.yaml` — the worker Deployment (config/securityContext/rootfs wiring).
- `worker-config.example.yaml` — the mounted worker config Secret (external PG + jwt + secrets).
- `tests/validate-manifests.sh`, `tests/hermetic-build-check.sh` — the deploy-hardening acceptance harnesses.
- `scripts/cloud-sim-guard.sh` — the no-cloud-credentials guard. (`scripts/cloud-sim.sh`, `scripts/cloud-sim-kind.sh` are RETIRED-SUBSTRATE stubs.)
- `scripts/cloud-sim-floci.sh` — the floci substrate (AWS: S3 :4566 + EKS→k3s).
- `scripts/cloud-sim-floci-gcp.sh` + `scripts/floci-gcp-gcs-compat-proxy.py` — the floci-gcp substrate (GCP: GCS :4588 + shim :4599 + GKE→k3s).
- `.github/workflows/cloud-sim.yml` — the per-commit Level-1 gate (enforcement
  externally blocked, DEC-7).
