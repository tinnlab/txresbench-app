# Real-cloud deployment runbook — S3/GCS × EKS/GKE

**Epic [#67](https://github.com/phibya/cytoanalyst/issues/67).** The local substrate
(`README.md`, floci + floci-gcp) proves the *mechanism*: a `cytoanalyst worker` pod fetches
content-addressed inputs from an ObjectStore, runs the analysis under bwrap + squashfuse
in-pod, and writes outputs back to the store + catalog. That was driven end-to-end twice —
job `0534f72e` on floci S3 + k3s, job `adc32c26` on floci-gcp GCS + GKE-k3s.

What the emulators **cannot** prove is real IAM, real workload identity, real cross-provider
egress, and real registry pulls. This document is the operator procedure for those, written so
that provisioning a real AWS account and a real GCP project turns the storage×compute matrix
into *execution*, not discovery.

**Read the substrate README first** — `src-app/cloud-sim/README.md`, especially its
"Deploying the worker (reproducible runbook)" section. This runbook does not repeat the
emulator recipes; it covers only what changes when the cloud is real.

---

## 0. How to read this document

Every non-obvious claim carries one of three markers:

| Marker | Meaning |
|---|---|
| **[VERIFIED]** | Read out of committed code/manifests in this repo (or the pinned `object_store` 0.13.2 source). The file:line is cited. |
| **[INFERRED]** | Deduced from what the code demonstrably does (e.g. an IAM action derived from the HTTP verb the crate issues). Sound, but not executed against a real cloud. |
| **[VERIFY AT PROVISIONING]** | Cloud-side behaviour this repo cannot pin down. Confirm it the first time you run the step; correct this file if reality differs. |

Console click-paths are deliberately omitted — CLI only, so a step is either reproducible or
absent.

> **Do not run the emulator tiers from a shell that holds real cloud credentials.**
> `scripts/cloud-sim-guard.sh` **[VERIFIED]** hard-fails the moment `AWS_PROFILE`,
> `AWS_ROLE_ARN`, `AWS_WEB_IDENTITY_TOKEN_FILE`, `GOOGLE_APPLICATION_CREDENTIALS`, an
> `AKIA…`/`ASIA…` key, a non-loopback endpoint override, or a reachable instance-metadata
> service is present (`scripts/cloud-sim-guard.sh:52-101`). That is by design. Use a separate
> shell (or a separate box) for real-cloud work.

---

## 1. What you are deploying

### 1.1 The default topology — worker-pod-runs-Local

A long-lived `cytoanalyst worker` Deployment claims queued jobs from Postgres and runs the
**unchanged** local bwrap backend *in-process, inside the pod*. **[VERIFIED]**
`src-app/cloud-sim/worker.Dockerfile:3-6`; `src-app/server/src/lib.rs:374-387` (`run_worker`
→ `build_app`, no public router); `src-app/server/src/main.rs:161`.

```
 Postgres (jobs queue)
        │  claim
        ▼
 ┌──────────────────────────────┐
 │  cytoanalyst worker pod      │      GET blobs/<sha256>
 │  ├─ materialize_inputs  ─────┼────────────────────────►  ObjectStore (S3 / GCS)
 │  ├─ bwrap + squashfuse       │                                    ▲
 │  └─ finalize_analysis   ─────┼────────────────────────────────────┘
 └──────────────────────────────┘      PUT blobs/<sha256>  + catalog rows
```

Consequences that drive this whole runbook:

- The worker needs **object-store credentials**, not Kubernetes credentials. It makes **no**
  Kubernetes API calls in this topology.
- The worker needs the **sandbox host properties** (bwrap userns, `/dev/fuse`, unmasked
  `/proc`) *inside the pod*.
- Every blob lives under one flat prefix, `blobs/<sha256-hex>` **[VERIFIED]**
  `object_store/s3.rs:136,254-257`. That is the only prefix any IAM policy here needs.

### 1.2 The fallback topology — job-per-run (#66)

For `ResourceClass::{Gpu, Highmem, ClusterBatch}` the `KubernetesBackend` mints one k8s `Job`
per run whose pod executes `cytoanalyst run-job --job-id <id>` — the *same* in-pod pipeline.
**[VERIFIED]** `modules/sandbox/backend/kubernetes.rs:1-22,210-215`; `lib.rs:405-434`.
This topology additionally needs Kubernetes RBAC for whichever process runs the scheduler
(§5.5).

### 1.3 The coupling rule (#61)

Remote (Kubernetes) compute paired with a **Local** object store is refused with a **422
`INCOMPATIBLE_BACKENDS`** at both admin PUT boundaries, and `KubernetesBackend::launch`
refuses to mint a Job when no object store is configured. **[VERIFIED]**
`modules/workstore/backend_compat.rs:59-95`; `modules/sandbox/backend/kubernetes.rs:406-417`.
So: **cloud store first, cluster compute second.**

---

## 2. Five facts to internalise before you touch a cloud console

These are the ones that cost time if you learn them at 2 a.m.

### 2.1 `S3_ENDPOINT` / `STORAGE_EMULATOR_HOST` are DEBUG-ONLY. A release worker ignores them.

`endpoint_seam()` returns the raw value only under `#[cfg(debug_assertions)]`; in a release
build the reader is compiled out and the function returns `None`. **[VERIFIED]**
`modules/workstore/config.rs:130-141`, pinned by the test
`endpoint_override_is_a_debug_only_seam` (`config.rs:816-834`).

A release worker pointed at a custom endpoint by env var will silently talk to **real AWS**
instead. The release-safe path for a custom endpoint is the admin DB row (§6) — `merge_s3_conn`
carries `db.endpoint` with **no** `debug_assertions` gate. **[VERIFIED]** `config.rs:484-510`,
pinned by `release_worker_reads_custom_endpoint_from_db_infra_config` (`config.rs:621-661`).

For a *stock* AWS S3 or Google GCS bucket you do not need an endpoint at all — leave it unset
and the provider's public endpoint is used. The seam only matters for S3-compatible stores.

### 2.2 The backend/provider pair is `CYTO_WORKSTORE_BACKEND=s3` + `CYTO_WORKSTORE_CLOUD=gcs`

`CYTO_WORKSTORE_BACKEND` selects *whether* the cloud backend is used; its only valid values
are `local`, `local-fs`, `s3` (case-sensitive, whitespace trimmed). `CYTO_WORKSTORE_CLOUD`
selects the *provider* (`gcs`/`gcp` ⇒ the native `GoogleCloudStorageBuilder`). **[VERIFIED]**
`config.rs:148-155,317-357`.

`CYTO_WORKSTORE_BACKEND=gcs` — the intuitive-but-wrong spelling — **fails the boot closed**
(#69), and the same value stored via the admin API is refused with a 422 (#70). **[VERIFIED]**
`config.rs:317-329` (boot error), `config.rs:370-385` (`validate_admin_backend`, 422),
`config.rs:463-478` (`merge_backend`, defense-in-depth). Tests:
`backend_selector_fails_closed_on_unrecognized_value`,
`validate_admin_backend_rejects_unrecognized_with_422`.

So for GCS:

```
CYTO_WORKSTORE_BACKEND=s3        # ← yes, "s3". This is the cloud opt-in, not the provider.
CYTO_WORKSTORE_CLOUD=gcs         # ← this is the provider.
```

### 2.3 The worker boots from a mounted config **file**, never from `DATABASE_URL`

`ServerConfig::load()` reads exactly one YAML, discovered via `CONFIG_FILE`. There is no env
overlay for Postgres / jwt / at-rest key, so a worker given only env vars exits with
"no config file found". **[VERIFIED]** `worker-config.example.yaml:1-15`;
`worker-deployment.scaffold.yaml:102-104` mounts the Secret at `/etc/cytoanalyst/config.yaml`
and sets `CONFIG_FILE`.

### 2.4 squashfuse needs `/dev/fuse`; bwrap does not need privilege

CELL-1's finding, now committed: `securityContext.privileged: true` is required for
squashfuse to open `/dev/fuse`. bwrap's unprivileged user namespaces need **no** privilege.
**[VERIFIED]** `worker-deployment.scaffold.yaml:93-100`; `worker.Dockerfile:8-12`.
The least-privilege alternative (a `/dev/fuse` device plugin) is discussed — with an important
unproven caveat — in §5.3.

### 2.5 The worker image must be built hermetically

Every `build.rs` in the tree — including the **frozen** SDK crates — provisions a sqlx build
database on `127.0.0.1:54321` and panics if it cannot connect; none honour `SQLX_OFFLINE`.
The Dockerfile therefore stands up its own throwaway Postgres inside the builder stage.
**[VERIFIED]** `worker.Dockerfile:14-25,57-70`. Build only via `just cloud-sim-worker-build`
(or the exact `docker build` it wraps) from a clean checkout at the repo root.

---

## 3. Prerequisites and least-privilege IAM

### 3.0 The exact object-store operations the product issues

Everything in §3.1/§3.2 is derived from this table, so it is the thing to check if a policy
ever looks wrong. Left column: the `ObjectStore` trait method. Middle: the `object_store`
0.13.2 call. Right: the wire request. **[VERIFIED]** — methods at
`modules/workstore/object_store/s3.rs:276-545`; wire verbs at `object_store-0.13.2`
`src/aws/client.rs:655-790,868,904-926` and `src/gcp/client.rs:458-564,673`.

| Product op | crate call | S3 wire | GCS wire |
|---|---|---|---|
| `put` (small), dedup probe | `head`, `put` | `HEAD` object, `PUT` object | metadata GET, upload |
| `put` (≥ threshold) | `put_multipart` → `put_part` → `complete` | `POST ?uploads`, `PUT ?partNumber&uploadId`, `POST ?uploadId` | XML multipart |
| multipart failure path | `abort` | `DELETE ?uploadId` | XML multipart abort |
| `get`, `get_range`, `get_stream` | `get`, `get_range`, `get_opts` | `GET` object (+ `Range`) | `GET` object |
| `stat`, `exists` | `head` | `HEAD` object | metadata GET |
| `delete` | `delete` | `DELETE` object | `DELETE` object |
| `gc`, `list_keys` | `list(Some("blobs"))` | `GET ?list-type=2&prefix=…` | `GET ?list-type=2&prefix=…` |

Multipart triggers at 16 MiB by default with 8 MiB parts (5 MiB floor). **[VERIFIED]**
`config.rs:119-123,169-174`; `s3.rs:287`.

Note what is **absent**: no bucket creation, no bucket policy/ACL reads, no tagging, no
versioning, no `ListMultipartUploads`, no `ListParts`. Do not grant those.

---

### 3.1 AWS

#### 3.1.1 The bucket

```bash
export AWS_REGION=eu-west-1
export BUCKET=cyto-worklab-prod

aws s3api create-bucket --bucket "$BUCKET" --region "$AWS_REGION" \
  --create-bucket-configuration LocationConstraint="$AWS_REGION"

# Blobs are content-addressed and immutable; versioning only multiplies storage cost.
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

**[VERIFY AT PROVISIONING]** If you enable SSE-KMS on the bucket, the worker's role
additionally needs `kms:Decrypt` and `kms:GenerateDataKey` on the key. The product issues no
KMS call itself; this is standard S3-with-KMS behaviour, not something this repo pins.

Lifecycle rule worth adding **[INFERRED]**: the multipart abort path is best-effort and logs a
warning if the abort itself fails (`s3.rs:307-321`), so a bucket-level
`AbortIncompleteMultipartUpload` rule (e.g. 7 days) prevents stranded billable parts.

#### 3.1.2 The least-privilege bucket policy

Derived line by line from §3.0. **[INFERRED]** from the verified wire verbs — the mapping
verb → IAM action is AWS's, not this repo's.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListTheBlobPrefix",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::cyto-worklab-prod"
    },
    {
      "Sid": "ReadWriteBlobs",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:AbortMultipartUpload"
      ],
      "Resource": "arn:aws:s3:::cyto-worklab-prod/blobs/*"
    }
  ]
}
```

- `s3:GetObject` covers both `GetObject` and `HeadObject`. **[VERIFY AT PROVISIONING]**
- `s3:PutObject` covers `CreateMultipartUpload`, `UploadPart` and
  `CompleteMultipartUpload`. **[VERIFY AT PROVISIONING]**
- `s3:ListBucket` is a **bucket-ARN** action; it must not carry the `/blobs/*` suffix.
- You may tighten `ListTheBlobPrefix` with a `Condition` on `s3:prefix`, but the exact prefix
  string the crate sends (`blobs` vs `blobs/`) is a crate detail — **[VERIFY AT PROVISIONING]**
  with CloudTrail before enabling that condition, or a GC sweep will silently list nothing.
- `s3:ListBucketMultipartUploads` / `s3:ListMultipartUploadParts` are **not** needed: the code
  never enumerates uploads or parts. **[VERIFIED]** (absent from `s3.rs`).

```bash
aws iam create-policy --policy-name CytoWorkstoreS3 \
  --policy-document file://cyto-workstore-s3.json
```

#### 3.1.3 EKS cluster + node group

Nothing here is product-specific; the constraints that *are* product-specific are in §5.

```bash
eksctl create cluster --name cyto-prod --region "$AWS_REGION" \
  --nodegroup-name workers --node-type m6i.2xlarge --nodes 2 \
  --with-oidc
```

`--with-oidc` creates the IAM OIDC provider that IRSA needs. Without eksctl:

```bash
aws eks describe-cluster --name cyto-prod --query cluster.identity.oidc.issuer --output text
aws iam create-open-id-connect-provider --url <that issuer> \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list <root CA thumbprint>   # VERIFY AT PROVISIONING
```

#### 3.1.4 ⚠ IRSA does **not** currently reach the object store — read this before designing your auth

This is the single most important real-cloud finding in this document, and it contradicts an
optimistic comment in the source.

`S3Store::from_conn` constructs the client with **`AmazonS3Builder::new()`**. **[VERIFIED]**
`modules/workstore/object_store/s3.rs:197`.

In `object_store` 0.13.2, `AmazonS3Builder::new()` is `Default::default()` and reads **no**
environment at all; only `AmazonS3Builder::from_env()` (or explicit `with_config` calls)
populates `web_identity_token_file` / `role_arn` /
`container_credentials_full_uri`. **[VERIFIED]** `object_store-0.13.2/src/aws/builder.rs:553-599`.

And in `build()`, the credential chain is a strict `if/else` over the **builder's own
fields**: static creds → web identity (only if both `web_identity_token_file` *and* `role_arn`
are set on the builder) → ECS task creds → EKS Pod Identity → **else the EC2 Instance
Metadata provider**. **[VERIFIED]** `object_store-0.13.2/src/aws/builder.rs:1090-1179`.

Therefore, with no static credentials configured:

| Auth mechanism | Injects | Reached by this code? |
|---|---|---|
| **IRSA** (service-account annotation) | `AWS_ROLE_ARN` + `AWS_WEB_IDENTITY_TOKEN_FILE` env | **NO** — builder fields never populated **[VERIFIED]** |
| **EKS Pod Identity** | `AWS_CONTAINER_CREDENTIALS_FULL_URI` + token file env | **NO** — same reason **[VERIFIED]** |
| **EC2 node instance profile** (IMDS) | — (the `else` branch) | **YES** **[VERIFIED]** |
| **Static access key / secret** | admin DB row or `AWS_*` env Secret | **YES** **[VERIFIED]** `s3.rs:209-211`, `config.rs:166-167` |

The doc comment at `s3.rs:207-208` ("absent ⇒ the crate's ambient identity chain (IRSA /
web-identity / IMDS)") is **wrong about IRSA**. Fixing it is a one-line product change —
seed the builder from `AmazonS3Builder::from_env()`, or forward the two web-identity fields
via `with_config` — but this is a documentation branch and product Rust is out of scope here.
**File this as a follow-up under #67 before you rely on IRSA.**

**What to do today**, in order of preference:

1. **Node instance-profile role (works now).** Attach `CytoWorkstoreS3` to the node group's
   instance role. Least-privilege at the *node* granularity, not the pod:
   ```bash
   ROLE=$(aws eks describe-nodegroup --cluster-name cyto-prod --nodegroup-name workers \
            --query 'nodegroup.nodeRole' --output text | awk -F/ '{print $NF}')
   aws iam attach-role-policy --role-name "$ROLE" \
     --policy-arn arn:aws:iam::<acct>:policy/CytoWorkstoreS3
   ```
   **[VERIFY AT PROVISIONING]** the pod can actually reach IMDS. EKS node groups often set
   the instance metadata **hop limit to 1**, which blocks pods (one extra network hop). Check
   and, if required, raise it:
   ```bash
   # from inside a pod on the node:
   TOKEN=$(curl -sS -X PUT "http://169.254.169.254/latest/api/token" \
            -H "X-aws-ec2-metadata-token-ttl-seconds: 60") && echo "IMDS reachable"
   ```
   Note the trade-off: with hop limit 2, *every* pod on the node inherits the role.
2. **Static keys via the admin DB row (works now, encrypted at rest).** §6. Create a
   dedicated IAM user with only `CytoWorkstoreS3` attached; rotate through the admin API.
3. **IRSA** — set it up anyway (it costs nothing and is the right end state), but do not
   *depend* on it until the builder change lands. Setup for reference:
   ```bash
   eksctl create iamserviceaccount --cluster cyto-prod --name cyto-worker \
     --namespace cyto --attach-policy-arn arn:aws:iam::<acct>:policy/CytoWorkstoreS3 \
     --approve
   # then add to the worker Deployment's pod spec:  serviceAccountName: cyto-worker
   ```

---

### 3.2 GCP

#### 3.2.1 The bucket

```bash
export PROJECT=cyto-prod
export REGION=europe-west1
export BUCKET=cyto-worklab-prod

gcloud storage buckets create "gs://$BUCKET" --project="$PROJECT" \
  --location="$REGION" --uniform-bucket-level-access
```

Uniform bucket-level access is recommended: the product never touches per-object ACLs
**[VERIFIED]** (no ACL call anywhere in `s3.rs`).

#### 3.2.2 The least-privilege role

Derived from §3.0. **[INFERRED]** — the operation → permission mapping is Google's.

| Product op | Permission |
|---|---|
| `get` / `get_range` / `stat` / `exists` | `storage.objects.get` |
| `put` / multipart upload | `storage.objects.create` |
| `delete` / multipart abort | `storage.objects.delete` |
| `gc` / `list_keys` | `storage.objects.list` |

The predefined role that covers exactly these four is **`roles/storage.objectAdmin`**
(`roles/storage.objectUser` is the newer equivalent). **[VERIFY AT PROVISIONING]** —
confirm your org's version of the role still contains all four. A custom role is tighter:

```bash
gcloud iam roles create cytoWorkstoreObjects --project="$PROJECT" \
  --title="CytoAnalyst workstore objects" \
  --permissions=storage.objects.get,storage.objects.create,storage.objects.delete,storage.objects.list \
  --stage=GA
```

Bind at the **bucket**, not the project:

```bash
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:cyto-worker@$PROJECT.iam.gserviceaccount.com" \
  --role="projects/$PROJECT/roles/cytoWorkstoreObjects"
```

**[VERIFY AT PROVISIONING]** The GCS path in `object_store` 0.13.2 uses the **XML API** for
listing (`list-type=2`, `src/gcp/client.rs:673`) — the same reason the local substrate needed
a compat shim. XML-API listing is normally covered by `storage.objects.list`; confirm against
audit logs on the first `gc` sweep.

#### 3.2.3 GKE cluster + Workload Identity

```bash
gcloud container clusters create cyto-prod --project="$PROJECT" --region="$REGION" \
  --workload-pool="$PROJECT.svc.id.goog" \
  --machine-type=e2-standard-8 --num-nodes=2

gcloud iam service-accounts create cyto-worker --project="$PROJECT"

# bind the KSA (namespace cyto, name cyto-worker) to the GSA
gcloud iam service-accounts add-iam-policy-binding \
  "cyto-worker@$PROJECT.iam.gserviceaccount.com" \
  --role=roles/iam.workloadIdentityUser \
  --member="serviceAccount:$PROJECT.svc.id.goog[cyto/cyto-worker]"

kubectl create namespace cyto
kubectl create serviceaccount cyto-worker -n cyto
kubectl annotate serviceaccount cyto-worker -n cyto \
  iam.gke.io/gcp-service-account="cyto-worker@$PROJECT.iam.gserviceaccount.com"
```

Then add `serviceAccountName: cyto-worker` to the worker Deployment's pod spec.

#### 3.2.4 Why GKE Workload Identity **does** work (unlike IRSA)

`GoogleCloudStorageBuilder::build()`, given no explicit service-account and no ADC file,
falls through to `InstanceCredentialProvider::default()` — the **GCE metadata server**
(`metadata.google.internal`). **[VERIFIED]** `object_store-0.13.2/src/gcp/builder.rs:583-592`
and `src/gcp/credential.rs:53`. GKE Workload Identity is implemented precisely by intercepting
that metadata server and returning the bound GSA's token, so this path is reached.
**[VERIFY AT PROVISIONING]** — the code path is confirmed; the end-to-end token exchange is
not something this repo can prove.

Two related facts that will bite otherwise, both **[VERIFIED]**
(`object_store-0.13.2/src/gcp/credential.rs:562-586`, `src/gcp/builder.rs:504-537`):

- The product calls `GoogleCloudStorageBuilder::new()` (`s3.rs:217`), which reads **no**
  environment. `GOOGLE_APPLICATION_CREDENTIALS` is therefore **not** honoured.
- Application Default Credentials are read only from
  `$HOME/.config/gcloud/application_default_credentials.json`, and only for credential
  `type` **`service_account`** or **`authorized_user`**. **`external_account` (Workload
  Identity Federation) is not a supported variant in this crate version** — see §8.3.

---

## 4. Worker image → a registry the cluster can pull

### 4.1 Build

```bash
# from a CLEAN checkout, at the repo root — the build context is the whole tree
just cloud-sim-worker-build                       # → cyto-sim-worker:dev  (release profile)
```

**[VERIFIED]** `justfile:553-554`; `worker.Dockerfile:44,64-68`.

**Choose the profile deliberately** — `--build-arg WORKER_PROFILE=debug|release`,
default `release` **[VERIFIED]** `worker.Dockerfile:44`:

| Profile | Endpoint override | Use for |
|---|---|---|
| `release` (default) | `S3_ENDPOINT` / `STORAGE_EMULATOR_HOST` **ignored** (§2.1) | **All real-cloud deployments.** Stock S3/GCS need no endpoint; a custom endpoint comes from the DB row. |
| `debug` | endpoint env honoured | Emulator work only. Never ship this to a real cluster — it will accept a redirect. |

For a real cloud, build `release`. Full stop.

```bash
docker build -f src-app/cloud-sim/worker.Dockerfile \
  -t cyto-worker:$(git rev-parse --short HEAD) .    # equivalently, pinned by commit
```

Tag by commit, not `:latest` — the scaffold's `imagePullPolicy: IfNotPresent`
(`worker-deployment.scaffold.yaml:91`) will happily keep a stale `:latest` on a node forever.

### 4.2 Push to ECR

```bash
aws ecr create-repository --repository-name cytoanalyst/worker --region "$AWS_REGION"
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin <acct>.dkr.ecr.$AWS_REGION.amazonaws.com

docker tag cyto-worker:$SHA <acct>.dkr.ecr.$AWS_REGION.amazonaws.com/cytoanalyst/worker:$SHA
docker push          <acct>.dkr.ecr.$AWS_REGION.amazonaws.com/cytoanalyst/worker:$SHA
```

**Pull auth on EKS:** the node instance role needs the AWS-managed
`AmazonEC2ContainerRegistryReadOnly` (or equivalent `ecr:GetAuthorizationToken`,
`ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer`). With that, **no `imagePullSecrets` are
needed** — the kubelet's ECR credential provider handles it. **[VERIFY AT PROVISIONING]**

### 4.3 Push to Artifact Registry

```bash
gcloud artifacts repositories create cytoanalyst --repository-format=docker \
  --location="$REGION" --project="$PROJECT"
gcloud auth configure-docker "$REGION-docker.pkg.dev"

docker tag cyto-worker:$SHA "$REGION-docker.pkg.dev/$PROJECT/cytoanalyst/worker:$SHA"
docker push                 "$REGION-docker.pkg.dev/$PROJECT/cytoanalyst/worker:$SHA"
```

**Pull auth on GKE:** grant `roles/artifactregistry.reader` to the **node** service account
(not the workload GSA — image pull happens before the pod exists):

```bash
NODE_SA=$(gcloud container clusters describe cyto-prod --region "$REGION" \
           --format='value(nodeConfig.serviceAccount)')
gcloud artifacts repositories add-iam-policy-binding cytoanalyst \
  --location="$REGION" --member="serviceAccount:$NODE_SA" \
  --role=roles/artifactregistry.reader
```

**[VERIFY AT PROVISIONING]** Same-project GKE→Artifact Registry usually works with the
default node SA and no `imagePullSecrets`.

### 4.4 Cross-registry pulls (needed for the cross-provider pairings)

An EKS node pulling from Artifact Registry, or a GKE node pulling from ECR, needs an explicit
`imagePullSecrets`. The simplest reliable approach is to **push the same image to both
registries** and have each cluster pull from its own — image identity is by digest anyway, so
this costs nothing in correctness. Do that unless you have a reason not to.

### 4.5 Set the image in the manifest

The scaffold ships a placeholder **[VERIFIED]** `worker-deployment.scaffold.yaml:90`:

```bash
sed "s|REPLACE_WITH_WORKER_IMAGE|<registry>/cytoanalyst/worker:$SHA|" \
  src-app/cloud-sim/worker-deployment.scaffold.yaml > /tmp/worker-deployment.yaml
```

---

## 5. Cluster prerequisites for the sandbox

The pod runs bwrap + squashfuse. Three host properties must hold **inside the pod**.
**[VERIFIED]** `modules/sandbox/mod.rs:9-33`.

### 5.1 Unprivileged user namespaces on the nodes

bwrap uses `--unshare-user --unshare-pid`. On a stock bare-metal Linux node with
`CONFIG_USER_NS=y` this just works; Ubuntu's AppArmor restriction is the usual spoiler.
**[VERIFIED]** `modules/sandbox/probes.rs:44-58`.

Verify on a real node (via a debug pod or SSM/SSH):

```bash
cat /proc/sys/user/max_user_namespaces                      # must be > 0
cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null  # 1, or absent (= allowed)
cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null  # 0, or absent
unshare -Ur true && echo "unprivileged userns OK"
```

**[VERIFY AT PROVISIONING]** Amazon Linux 2023, Bottlerocket and GKE COS: no AppArmor
userns restriction as of writing. Ubuntu 24.04-based node images set
`apparmor_restrict_unprivileged_userns=1` and need a sysctl (a `DaemonSet` with
`securityContext.privileged` writing the sysctl, or a node bootstrap script).

### 5.2 `/dev/fuse` — the privileged path (proven)

The committed scaffold uses `securityContext.privileged: true`. **[VERIFIED]**
`worker-deployment.scaffold.yaml:99-100`. This is what CELL-1 and the GCS/GKE run actually
used. It grants `/dev/fuse` **and**, incidentally, an unmasked `/proc` (§5.4).

Verify in a running pod:

```bash
kubectl exec -n cyto deploy/cyto-sim-worker -- sh -c 'ls -l /dev/fuse && which squashfuse bwrap'
kubectl exec -n cyto deploy/cyto-sim-worker -- sh -c \
  'unshare -Ur true && echo userns-ok'
```

### 5.3 `/dev/fuse` — the least-privilege alternative (**not** proven; read the caveat)

Deploy a fuse device plugin, drop `privileged`, and request the device:

```yaml
        securityContext:
          privileged: false
          capabilities: { drop: ["ALL"] }
        resources:
          limits:
            github.com/fuse: 1
```

**[VERIFIED]** that this is the documented intent (`worker-deployment.scaffold.yaml:93-98`;
README §5). **[INFERRED, AND THE IMPORTANT CAVEAT]**: `/dev/fuse` is *not the only* thing
`privileged: true` was providing. The sandbox also requires a **fresh, unmasked `/proc`** —
`probe_rootfs_dependent` **refuses to run** (self-disables the sandbox) if a strict PID
namespace cannot be established, and the error text names container `/proc` masking as the
usual cause. **[VERIFIED]** `modules/sandbox/probes.rs:37-60`.

Kubernetes masks `/proc` paths for non-privileged containers by default. `securityContext.
procMount: Unmasked` exists but has its own gating. **[VERIFY AT PROVISIONING]** — if you go
the device-plugin route, expect to also need `procMount: Unmasked` (and to confirm your
cluster permits it), and validate with a real analysis before declaring least-privilege done.
The privileged path is the only one this project has actually run.

### 5.4 `user_allow_other` in `/etc/fuse.conf`

The rootfs is squashfuse-mounted with `-o allow_other` so bwrap's uid-1001 process can read
it; from a **non-root** mounter that requires `user_allow_other` in `/etc/fuse.conf`.
**[VERIFIED]** `modules/rootfs/mount.rs:135-140`; `modules/sandbox/mod.rs:18-22`.

The shipped worker image declares no `USER`, so the pod runs as **root** and the flag is not
needed. **[VERIFIED]** `worker.Dockerfile` (no `USER` directive). If you add `runAsNonRoot`
or a `USER`, you must also bake `user_allow_other` into `/etc/fuse.conf` in the image — the
symptom otherwise is a silent hang: `<mnt>/usr did not appear within 5s`.

### 5.5 Kubernetes RBAC — only for the job-per-run topology

The default worker-pod topology needs **no** RBAC. The `KubernetesBackend` (whichever process
runs the scheduler with `CYTO_COMPUTE_BACKEND=kubernetes`) calls, all **[VERIFIED]** in
`modules/sandbox/backend/kubernetes.rs`: `Job` create (`:429`), `Job` `get_status` (`:589`),
`Job` delete (`:394`), `Pod` list by label (`:565`), `Pod` logs (`:622,645`).

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: cyto-compute, namespace: cyto }
rules:
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["create", "get", "list", "delete"]
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list"]
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]
```

**[INFERRED]** from the call list — the verb ↔ API-call mapping is Kubernetes'.

---

## 6. Configure the object store the production way

### 6.1 The two release-safe credential sources

1. **Ambient identity** — nothing configured; the crate's chain applies (§3.1.4 for AWS,
   §3.2.4 for GCP). Note: on AWS this means the **node instance role**, not IRSA.
2. **Static credentials, encrypted at rest**, via the admin API (#63). This is also the only
   release-safe way to set a **custom endpoint**.

Env vars remain the fallback layer and are byte-identical when the DB row is empty
(`ObjectStoreDbConfig::is_empty()` ⇒ `merge_s3_conn` returns the env config unchanged).
**[VERIFIED]** `config.rs:438-510`, test `effective_object_store_merge_prefers_db_then_env`.

### 6.2 `PUT /api/admin/infra/object-store`

**[VERIFIED]** routes at `modules/workstore/infra_object_store.rs:689-700`; permission
`infra::settings::manage` on every handler (`:525,620,663`); saas-gated module (`:16-19`).

Prerequisite: `secrets.storage_key` must be set (in the mounted config, or via
`CYTO_SECRET_STORAGE_KEY`). Without it the PUT refuses with **400 `SECRET_STORAGE_DISABLED`**
rather than storing plaintext. **[VERIFIED]** `infra_object_store.rs:673-686`.

**AWS S3, stock endpoint, static keys:**

```bash
curl -sS -X PUT https://<api-host>/api/admin/infra/object-store \
  -H "Authorization: Bearer <admin-token>" -H 'Content-Type: application/json' \
  -d '{
        "backend": "s3",
        "provider": "s3",
        "bucket":   "cyto-worklab-prod",
        "region":   "eu-west-1",
        "path_style": false,
        "access_key_id":     "AKIA…",
        "secret_access_key": "…"
      }'
```

**GCS, stock endpoint, ambient (Workload Identity):**

```bash
curl -sS -X PUT https://<api-host>/api/admin/infra/object-store \
  -H "Authorization: Bearer <admin-token>" -H 'Content-Type: application/json' \
  -d '{"backend": "s3", "provider": "gcs", "bucket": "cyto-worklab-prod"}'
```

Note again: `backend` is `"s3"`, `provider` is `"gcs"` (§2.2). `backend: "gcs"` is refused
**422 `INVALID_OBJECT_STORE_BACKEND`**. **[VERIFIED]** `config.rs:370-385`.

**A custom S3-compatible endpoint (the only release-safe way):**

```bash
… -d '{"backend":"s3","provider":"s3","endpoint":"https://objstore.internal:9000",
       "bucket":"prod-worklab","region":"eu-west-1","path_style":true,
       "access_key_id":"…","secret_access_key":"…"}'
```

Field semantics **[VERIFIED]** `infra_object_store.rs:77-105`, `config.rs:484-510`:
- Every field is optional; an omitted or blank field means **leave unchanged / fall through
  to env**. It does not mean "clear".
- A blank `access_key_id`/`secret_access_key` is leave-unchanged, so you cannot accidentally
  wipe a credential by re-submitting the masked form.
- Secrets are stored as `bytea` ciphertext; `GET` returns a masked view (`configured` flags +
  `access_key_last4`) and never the plaintext. **[VERIFIED]** `:44-67`, test
  `view_has_no_secret_field`.

### 6.3 Test the connection before deploying anything

```bash
curl -sS -X POST https://<api-host>/api/admin/infra/object-store/test \
  -H "Authorization: Bearer <admin-token>" -H 'Content-Type: application/json' -d '{}'
# → {"ok":true,"message":"…"}
```

This performs a real **put → get → delete** round-trip against the resolved config and
returns a fixed-vocabulary `{ok,message}` that never echoes the raw error or the credential.
**[VERIFIED]** `infra_object_store.rs:628-660` + module doc `:11-14`. You may pass candidate
`access_key_id`/`secret_access_key` in the body to test **without persisting** (`:636-643`).

A green test here proves the IAM policy of §3 in one call. Do this before the first deploy;
it is the cheapest possible feedback loop for a policy mistake.

### 6.4 When the config takes effect

The object store is built at **boot** from `resolve_effective_object_store` (`lib.rs:87-92`)
**[VERIFIED]**, so a changed store config requires a worker **restart** —
`kubectl rollout restart deploy/cyto-sim-worker -n cyto`. (Compute namespace/image from
`infra/compute` are read-at-use per launch and do **not** need a restart. **[VERIFIED]**
`kubernetes.rs:89-100`.)

---

## 7. Deploy

### 7.1 Postgres

The worker connects **out** to the same Postgres the API pod uses
(`use_embedded: false`). **[VERIFIED]** `worker-config.example.yaml:23-39`. Cloud SQL /
RDS both work; what matters is that the address is routable **from the pod**:

- In-cluster Postgres ⇒ the Service DNS name.
- RDS / Cloud SQL ⇒ the private endpoint, with the security group / authorized network
  admitting the node subnet.
- **Never `127.0.0.1`** — loopback inside a pod is the pod. Same rule as pod→store.
  **[VERIFIED]** `worker-deployment.scaffold.yaml:32-34`.

### 7.2 The two Secrets

```bash
kubectl create namespace cyto

# 1. the CONFIG_FILE Secret — edit every CHANGE_ME first
$EDITOR src-app/cloud-sim/worker-config.example.yaml
kubectl apply -n cyto -f src-app/cloud-sim/worker-config.example.yaml

# 2. the object-store env Secret
kubectl create secret generic cyto-worker-env -n cyto \
  --from-literal=CYTO_WORKSTORE_S3_BUCKET=cyto-worklab-prod \
  --from-literal=AWS_REGION=eu-west-1 \
  --from-literal=AWS_ACCESS_KEY_ID='' \
  --from-literal=AWS_SECRET_ACCESS_KEY=''
```

**[VERIFIED]** `README.md:180-189`; `worker-deployment.scaffold.yaml:108-118`.

`jwt.secret` **must match the API pod's**, and `secrets.storage_key` must match too — it is
the key the object-store credentials were encrypted under. Rotating `storage_key` makes
stored secrets undecryptable. **[VERIFIED]** `worker-config.example.yaml:48-60`.

For **GCS**, add `CYTO_WORKSTORE_CLOUD=gcs` to the env Secret (or set `provider: "gcs"` in
the DB row) and leave the `AWS_*` keys empty. Note the scaffold hard-references
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` **without** `optional: true`
(`worker-deployment.scaffold.yaml:113-118`) — the keys must **exist** in the Secret even if
their values are empty, or the pod will not start. Empty values resolve to `None`
(`env_opt` filters empty strings, **[VERIFIED]** `config.rs:512-514`), which is exactly the
ambient-identity path.

### 7.3 env-rootfs delivery — the one required decision

The image ships no `oras`/`cosign` and GHCR is private, so the worker cannot fetch its own
sandbox rootfs. The scaffold's `fetch-env-rootfs` initContainer is a **deliberately failing
placeholder** — the pod stays in `Init` until you choose. **[VERIFIED]**
`worker-deployment.scaffold.yaml:58-85`.

Pick one:

**(a) initContainer fetch.** Replace `REPLACE_WITH_ROOTFS_FETCHER_IMAGE` and the `args` body
with a real pull that leaves the file at `/env-rootfs/rootfs.squashfs`. A `read:packages`
token goes in the `cyto-worker-env` Secret (`ROOTFS_OCI_REF` is already wired,
`:80-82`). For real cloud, mirroring the rootfs into ECR/Artifact Registry (or an
S3/GCS object) avoids a GHCR dependency in the data path entirely.

**(b) Bake it into the image.** Add the documented `COPY` line to `worker.Dockerfile`
(`:91-95`) with the squashfs present in the build context, then **delete all three** of: the
`fetch-env-rootfs` initContainer, the `env-rootfs` volume, **and** the worker's `env-rootfs`
`volumeMount`. Leaving the volume mounted shadows the baked file with an empty dir.
**[VERIFIED]** `README.md:238-242`.

### 7.4 Apply

```bash
kubectl apply -n cyto -f /tmp/worker-deployment.yaml
kubectl scale -n cyto deploy/cyto-sim-worker --replicas=1   # KEDA owns this if installed
```

The Deployment ships `replicas: 0` because KEDA is expected to own the count
(`worker-deployment.scaffold.yaml:41`). **[VERIFIED]** For the first matrix run, scale
manually to 1 — one fewer moving part.

### 7.5 KEDA (optional)

`keda-scaledobject.yaml` scales the Deployment 0→5 on `SELECT count(*) FROM jobs WHERE
status = 'queued'`, with `minReplicaCount: 0`. **[VERIFIED]**
`keda-scaledobject.yaml:16-46`. It needs a `cyto-pg-conn` Secret with a `connection` key
holding a libpq URL:

```bash
kubectl create secret generic cyto-pg-conn -n cyto \
  --from-literal=connection='postgresql://user:pw@pg-host:5432/cytoanalyst?sslmode=require'
kubectl apply -n cyto -f src-app/cloud-sim/keda-scaledobject.yaml
```

**[VERIFY AT PROVISIONING]** KEDA multi-worker scaling has **not** been exercised on this
project (the epic notes it as out of CELL-1's scope). Do a single-replica matrix run first.

### 7.6 Pre-flight validation (no cluster needed)

```bash
bash src-app/cloud-sim/tests/validate-manifests.sh     # kubectl dry-run + wiring self-consistency
bash src-app/cloud-sim/tests/hermetic-build-check.sh   # build wiring (--full for a real build)
```

**[VERIFIED]** `README.md:252-256`.

### 7.7 Smoke checklist

Run these in order. Each has a single unambiguous pass signal.

| # | Check | Command | Pass signal |
|---|---|---|---|
| 1 | Image pulled | `kubectl get pod -n cyto -l app=cyto-sim-worker` | not `ImagePullBackOff` / `ErrImagePull` |
| 2 | initContainer delivered the rootfs | `kubectl logs -n cyto <pod> -c fetch-env-rootfs` | exits 0; §7.3 decision made |
| 3 | Config file found | `kubectl logs -n cyto <pod> -c worker` | **no** "no config file found" |
| 4 | **Store backend actually resolved** | `kubectl logs -n cyto <pod> -c worker \| grep 'content-addressed store initialized'` | the structured field reads `backend="s3"` — **`backend="local-fs"` means your cloud config did not take** |
| 5 | Worker is claiming | same log | `cytoanalyst worker started — claiming + running jobs (no public router)` |
| 6 | Sandbox host props | `kubectl exec -n cyto <pod> -- sh -c 'ls -l /dev/fuse; unshare -Ur true && echo userns-ok'` | device present, `userns-ok` |
| 7 | Store reachable **as the pod sees it** | admin `POST …/object-store/test` (§6.3) | `{"ok":true,…}` |

Check 4 is the single most valuable line in the deployment. **[VERIFIED]** — the log is
emitted by `init_working_store` with `backend = cfg.backend.as_str()`
(`modules/workstore/mod.rs:213-219`) and `ObjectStoreKind::Local.as_str()` is the literal
`"local-fs"` (`config.rs:36-43`). Since #69/#70 a *mis-set* backend fails the boot closed
rather than silently reading `local-fs`, but an **unset** `CYTO_WORKSTORE_BACKEND` with no DB
row still legitimately resolves to `Local` **[VERIFIED]** `config.rs:319` — and that is the
configuration mistake this line catches.

Startup log line 5 is also printed to stdout **[VERIFIED]** `lib.rs:379-380`.

---

## 8. Running the matrix

Four pairings. Two are proven on emulators at the analysis level; two exist only in real
clouds.

| | **AWS compute (EKS)** | **GCP compute (GKE)** |
|---|---|---|
| **S3 store** | §8.1 — emulator-proven (job `0534f72e`) | §8.3 — cross-provider, **real-cloud only** |
| **GCS store** | §8.3 — cross-provider, **real-cloud only** | §8.2 — emulator-proven (job `adc32c26`) |

### 8.1 S3 + EKS

Config: `backend=s3`, `provider=s3`, bucket + region set, credentials per §3.1.4.
No endpoint. Release image.

### 8.2 GCS + GKE

Config: `backend=s3`, `provider=gcs`, bucket set, `serviceAccountName: cyto-worker` on the
pod (§3.2.3). No endpoint, no static keys. Release image.

The `region` field is irrelevant to the GCS builder **[VERIFIED]** (`s3.rs:217-239` never
passes region to `GoogleCloudStorageBuilder`); leaving it at the default is harmless.

**[VERIFY AT PROVISIONING]** GCS **multipart** writes (blobs ≥ 16 MiB) have **never** been
exercised — floci-gcp 0.7.0 does not implement the GCS XML-multipart API, so that leg
self-skips on the emulator. **[VERIFIED]** `README.md:116-119`. This pairing is the first
real test of it. Make sure at least one output blob exceeds 16 MiB, or lower
`CYTO_WORKSTORE_S3_MULTIPART_THRESHOLD` **[VERIFIED]** `config.rs:169-170` to force the path.

### 8.3 The cross-provider pairings — what they actually require

This is the part no emulator can prove, and where the code imposes hard limits.

#### EKS pod → GCS bucket

The textbook answer is **GCP Workload Identity Federation**: register the EKS OIDC issuer as
a GCP workload-identity pool provider, and let the pod's projected service-account token be
exchanged for a Google access token via an `external_account` credential file.

**That does not work with this code.** `object_store` 0.13.2's ADC deserializer accepts only
`type: "service_account"` and `type: "authorized_user"` — `external_account` is **not a
variant**. **[VERIFIED]** `object_store-0.13.2/src/gcp/credential.rs:544-559`. And ADC is read
only from `$HOME/.config/gcloud/application_default_credentials.json`, because the product
calls `GoogleCloudStorageBuilder::new()` which reads no env. **[VERIFIED]**
`credential.rs:562-586`; `s3.rs:217`.

The only path that works today, and it is a static credential:

1. Create a GCP service account with the §3.2.2 role on the bucket.
2. Create a JSON key (`type: "service_account"`).
3. Mount it in the EKS pod as a Secret at
   `$HOME/.config/gcloud/application_default_credentials.json` — with `HOME` set so that
   path resolves (the image sets no `HOME`; container default is `/root` for uid 0).
   **[VERIFY AT PROVISIONING]** confirm `HOME` inside the pod before relying on the path.
4. Config: `backend=s3`, `provider=gcs`, bucket set, no endpoint.

Record honestly what this pairing proves: **cross-provider egress and GCS IAM work; federated
cross-provider identity does not, because the crate does not support it.** Two follow-ups
belong on #67: add an `external_account` path (or a service-account-key field to the
`infra_object_store` row, which today carries only `access_key_id`/`secret_access_key`
**[VERIFIED]** `infra_object_store.rs:79-95`).

#### GKE pod → S3 bucket

The textbook answer is an AWS IAM role with a web-identity trust policy on
`accounts.google.com`, assumed via `AssumeRoleWithWebIdentity`.

**That also does not work with this code**, for the reason in §3.1.4: the web-identity
provider is only reached when `web_identity_token_file` **and** `role_arn` are set on the
builder, and `AmazonS3Builder::new()` never populates them. **[VERIFIED]**
`object_store-0.13.2/src/aws/builder.rs:553-555,1107-1136`. GCE metadata is not AWS IMDS, so
the `else` branch cannot help either.

The only path that works today: a dedicated **IAM user** with the §3.1.2 policy, its access
key stored **encrypted** via the admin DB row (§6.2). Config: `backend=s3`, `provider=s3`,
bucket + region, static keys.

#### Network egress

**[VERIFY AT PROVISIONING]** Both cross-provider pairings need egress from private node
subnets to the *other* cloud's public API endpoints (`s3.<region>.amazonaws.com`,
`storage.googleapis.com`) — a NAT gateway / Cloud NAT and any egress firewall rules. Expect
cross-cloud data-transfer charges proportional to blob volume; content-addressed dedup
(`s3.rs:280-282` skips a re-upload when the object already exists) helps but does not
eliminate them.

### 8.4 Evidence to capture per pairing

Do not declare a pairing green on "the pod didn't crash". Capture all six:

| # | Evidence | How |
|---|---|---|
| 1 | Resolved backend | `kubectl logs` line from smoke check 4 — `backend="s3"`, plus the resolved `provider` in the admin GET |
| 2 | Inputs came **from** the store | worker log around `materialize_inputs` **[VERIFIED]** `modules/jobs/runner.rs:594`; count of input blobs fetched |
| 3 | The analysis ran **in-pod** | worker log shows the bwrap/squashfuse mount and the run's stage progression; job exit code **0** |
| 4 | Outputs landed **in the bucket** | `aws s3 ls s3://$BUCKET/blobs/ \| wc -l` / `gcloud storage ls gs://$BUCKET/blobs/` before vs after |
| 5 | Catalog agrees with the bucket | `artifacts` rows `status='ready'` **[VERIFIED]** `modules/workstore/catalog/repository.rs:79,137`, and each `object_key` matches a real `blobs/<sha256>` object |
| 6 | Metering recorded | a `compute_meter` row for the `job_id` **[VERIFIED]** `modules/jobs/seams.rs:535`; `storage_meter` rows |

Evidence 5 is the one that catches a "succeeded but wrote nowhere" failure. Check it.

### 8.5 Telling a real failure from a config mistake

| Symptom | It is a **config mistake** if… | It is a **real failure** if… |
|---|---|---|
| No blobs in the bucket, job exit 0 | smoke check 4 says `backend="local-fs"` | check 4 says `s3` and the bucket is still empty |
| `403`-class store error | the admin test-connection (§6.3) also fails | test-connection passes as the API pod but fails as the worker pod ⇒ **identity differs between pods**, not a policy bug |
| Worker never claims a job | `CYTO_SCHEDULER_ENABLED` off, or a different Postgres than the API's | queue has rows, worker logs the claim loop, nothing claimed |
| Analysis fails immediately | `/dev/fuse` missing, rootfs not delivered, `/proc` masked (§5) | all §7.7 checks 1–7 green and the analysis itself errors |
| Timeout on a heavy run | `activeDeadlineSeconds` too low (job-per-run only; `timeout_secs + slack`, slack default 900s **[VERIFIED]** `kubernetes.rs:298-310`) | deadline generous and the pod is genuinely stuck |

Rule of thumb: **every one of §7.7's seven checks must be green before you interpret any
analysis-level failure.** A red check 4 or 6 explains almost everything downstream.

---

## 9. Troubleshooting

Keyed by the failures this project has actually hit.

| Symptom | Cause | Fix |
|---|---|---|
| Blobs write to pod-local disk; vanish on pod death. Log: `backend="local-fs"` | `CYTO_WORKSTORE_BACKEND` unset **and** no DB row. An *unset* value legitimately means `Local` **[VERIFIED]** `config.rs:319` | Set `CYTO_WORKSTORE_BACKEND=s3` in the env Secret, or configure the DB row (§6.2). Confirm via smoke check 4. |
| Boot error: `CYTO_WORKSTORE_BACKEND='gcs' is not a recognized object-store backend` | The #69 fail-closed guard. `gcs` is a *provider*, not a backend | `CYTO_WORKSTORE_BACKEND=s3` **+** `CYTO_WORKSTORE_CLOUD=gcs` (§2.2) |
| Admin PUT returns **422 `INVALID_OBJECT_STORE_BACKEND`** | Same mistake on the admin path (#70) **[VERIFIED]** `config.rs:370-385` | `"backend":"s3"`, `"provider":"gcs"` |
| Admin PUT returns **422 `INCOMPATIBLE_BACKENDS`** | Remote (Kubernetes) compute + a Local store (#61) **[VERIFIED]** `backend_compat.rs:59-95` | Configure the cloud object store **first**, then select the Kubernetes compute backend |
| `KubernetesBackend` refuses to launch: "requires a configured object store" | Same coupling rule at launch **[VERIFIED]** `kubernetes.rs:406-417` | As above |
| Release worker hits **real AWS** despite `S3_ENDPOINT` | The endpoint env is a `#[cfg(debug_assertions)]` seam **[VERIFIED]** `config.rs:130-141` | Put the endpoint in the DB row (§6.2). Or build `WORKER_PROFILE=debug` — **emulator only** |
| Pod `Init` forever, `fetch-env-rootfs` exits 1: "initContainer must deliver /env-rootfs/rootfs.squashfs" | The placeholder initContainer, working as designed **[VERIFIED]** `worker-deployment.scaffold.yaml:78-79` | Make the §7.3 decision (real fetch, or bake + delete all three pieces) |
| Analysis fails: squashfuse cannot open `/dev/fuse` | Non-privileged pod without a fuse device plugin **[VERIFIED]** `worker.Dockerfile:8-12` | `securityContext.privileged: true`, or the device-plugin path **with** its `/proc` caveat (§5.3) |
| Sandbox self-disables: "a real PID namespace is not available… /proc is MASKED" | Masked `/proc` in the container **[VERIFIED]** `probes.rs:44-58` | Privileged pod (unmasked `/proc`), or `procMount: Unmasked` — **[VERIFY AT PROVISIONING]** |
| Mount hangs: `<mnt>/usr did not appear within 5s` | `-o allow_other` from a non-root mounter without `user_allow_other` **[VERIFIED]** `mount.rs:135-140` | Run the pod as root (default), or bake `user_allow_other` into `/etc/fuse.conf` |
| Worker exits: "no config file found" | `CONFIG_FILE` unset or the Secret not mounted **[VERIFIED]** `worker-config.example.yaml:1-6` | Apply `cyto-worker-config`; keep the scaffold's mount at `/etc/cytoanalyst` + `CONFIG_FILE` |
| Pod cannot start; `secretKeyRef` not found | `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION` are non-optional refs **[VERIFIED]** `worker-deployment.scaffold.yaml:113-118` | Create the keys with empty values (empty ⇒ ambient identity, `config.rs:512-514`) |
| `ImagePullBackOff` | No ECR/AR pull permission on the **node** role, or a cross-registry pull with no `imagePullSecrets` | §4.2/§4.3; for cross-provider, push to both registries (§4.4) |
| Stale image after a rebuild | `imagePullPolicy: IfNotPresent` + a moving tag **[VERIFIED]** `worker-deployment.scaffold.yaml:91` | Tag by commit SHA (§4.1) |
| Pod cannot reach the store / Postgres at `127.0.0.1` | Loopback in a pod is the pod **[VERIFIED]** `worker-deployment.scaffold.yaml:32-34` | Use a routable address: Service DNS, private endpoint, or the CNI bridge IP for a host-run service |
| `403` from S3 with no static keys on EKS | IRSA is **not** honoured; the chain reached IMDS and used the node role — or IMDS was unreachable (hop limit) | §3.1.4: attach the policy to the node role and check the hop limit, or use static keys |
| Store creds cannot be saved: **400 `SECRET_STORAGE_DISABLED`** | `secrets.storage_key` not configured **[VERIFIED]** `infra_object_store.rs:673-681` | Set `secrets.storage_key` in the mounted config (or `CYTO_SECRET_STORAGE_KEY`); keep it stable |
| Previously-saved creds stop decrypting | `secrets.storage_key` was rotated **[VERIFIED]** `worker-config.example.yaml:55-60` | Restore the old key, or re-enter the credentials |
| Stranded multipart uploads on the bill | Abort is best-effort and warns on failure **[VERIFIED]** `s3.rs:307-321` | Bucket lifecycle rule `AbortIncompleteMultipartUpload` (§3.1.1); grep worker logs for "multipart abort failed" |
| An emulator tier suddenly refuses to run | `cloud-sim-guard.sh` detected real cloud creds in the shell **[VERIFIED]** `cloud-sim-guard.sh:52-101` | Use a separate shell for real-cloud work (§0) |

---

## 10. Ledger — what this document does and does not claim

**Verified in committed code** (cited inline): the default and fallback topologies; the
release-only endpoint seam; the backend/provider pair and both fail-closed guards; the
coupling rule; the config-file boot requirement; the `/dev/fuse` + userns + `/proc` +
`allow_other` sandbox requirements; the full object-store operation set and its wire verbs;
the admin API surface, permission, encryption and test-connection semantics; the boot log
that reveals the resolved backend; every manifest wiring detail cited from the scaffold,
Dockerfile and config example; the exact credential-resolution chains of `object_store`
0.13.2 for both providers.

**Inferred** (sound, not executed): the wire-verb → IAM-action mapping in both clouds; the
Kubernetes RBAC verb list for the job-per-run backend; the multipart-lifecycle
recommendation; the claim that a fuse device plugin alone is insufficient because `/proc`
masking is a *separate* requirement.

**Could not verify — confirm at provisioning:** OIDC thumbprints; whether `s3:GetObject`
covers `HeadObject` and `s3:PutObject` covers all three multipart verbs in your account's
policy evaluation; the exact `s3:prefix` string the crate sends; the current contents of
`roles/storage.objectAdmin`; IMDS hop limits on your node group; node-image AppArmor userns
posture; whether your cluster permits `procMount: Unmasked`; registry pull auth without
`imagePullSecrets`; `HOME` inside the worker pod; GCS multipart writes (never exercised
anywhere); KEDA multi-worker scaling (never exercised); and all cross-cloud egress and
firewall behaviour.

**Known product gaps this runbook exposes** — file under #67 before depending on them:

1. **IRSA and EKS Pod Identity are unreachable** because `S3Store::from_conn` uses
   `AmazonS3Builder::new()` instead of seeding from `from_env()`/`with_config`
   (`s3.rs:197`). The doc comment at `s3.rs:207-208` claims otherwise and should be
   corrected along with the code.
2. **GCP Workload Identity Federation (`external_account`) is unsupported** by
   `object_store` 0.13.2, and there is no service-account-key field on the
   `infra_object_store` row — so an EKS pod reaching GCS is limited to a mounted static
   service-account key.
3. Consequently **neither cross-provider pairing can use federated identity today**; both
   require a static credential. That is a real finding about the product, not a gap in this
   procedure.
