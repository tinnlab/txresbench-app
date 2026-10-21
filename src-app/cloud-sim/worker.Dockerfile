# CytoAnalyst compute worker image (epic compute-storage, T3 / ITEM-7 / PROV-T3-4).
#
# Builds the `cytoanalyst` binary with the `saas` feature and runs it in `worker` mode:
# a fixed-pool worker Deployment claims queued jobs and runs the UNCHANGED LocalBwrapBackend
# in-process (worker-pod-runs-Local, the default topology — INV-1). The worker reads inputs /
# writes outputs through T2's `ObjectStore` over S3 (CYTO_WORKSTORE_BACKEND=s3).
#
# Runtime deps mirror the desktop sandbox host deps: bwrap + squashfuse + fuse3 (the bwrap
# sandbox + the env-rootfs squashfs mount). The pod runs with securityContext.privileged:true
# so squashfuse can open /dev/fuse (bwrap's unprivileged userns needs no privilege — only fuse
# does); the worker-deployment.scaffold.yaml documents the non-privileged /dev/fuse device-plugin
# alternative for least-privilege prod.
#
# ── HERMETIC BUILD (deploy-hardening gap #1) ──────────────────────────────────────────────
# Every crate's build.rs — the app's `provision_build_db` AND the FROZEN SDK crates
# (ziee-auth / ziee-file / ziee-seed / ziee-notification / ziee-onboarding) — provisions a
# per-worktree sqlx BUILD DATABASE on `127.0.0.1:54321` and PANICS if it cannot connect; none
# honor SQLX_OFFLINE. The SDK pin is frozen, so the build cannot be told to skip the DB. The
# hermetic answer is therefore a SELF-CONTAINED build-time Postgres started INSIDE the builder
# stage below (no external service, no host DB, no hand-editing). Build from a clean checkout,
# at the REPO ROOT, with the documented single command:
#
#     just cloud-sim-worker-build                       # → cyto-sim-worker:dev
#   OR, equivalently, the raw docker build it wraps:
#     docker build -f src-app/cloud-sim/worker.Dockerfile -t cyto-sim-worker:dev .
#
# Optional: bake the env-rootfs squashfs into the image at build (deploy-hardening gap #5) with
#   --build-arg ROOTFS_SQUASHFS=<path-relative-to-context>   (needs the file present in context;
# see the README for the initContainer delivery alternative that needs no bake token).
#
# Loaded onto the sim cluster WITHOUT a registry via `just cloud-sim-load-image` (PROV-T1-2),
# so the Deployment's imagePullPolicy is IfNotPresent. For the floci / floci-gcp k3s node
# that hook uses `docker save | ctr images import` — see the `cloud-sim-load-image` recipe.

# ---- builder ----
FROM rust:1-bookworm AS builder
WORKDIR /src
# WORKER_PROFILE selects the cargo build profile. Default `release` (production image).
# Build with `--build-arg WORKER_PROFILE=debug` for the GCS/S3 EMULATOR path: the
# STORAGE_EMULATOR_HOST / S3_ENDPOINT endpoint override is a `#[cfg(debug_assertions)]`
# seam (workstore/config.rs::endpoint_seam), so ONLY a debug worker can be redirected at
# floci-gcp / floci without a DB infra_object_store row. (GCS emulator has no DB-endpoint
# release path yet, so the debug build is REQUIRED to point the worker at floci-gcp GCS.)
ARG WORKER_PROFILE=release
# Build deps for the server crate (embedded PG build tooling, pkg-config, etc.) PLUS a
# postgresql server used ONLY at build time to satisfy the sqlx compile-time query macros.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential pkg-config libssl-dev make postgresql \
    && rm -rf /var/lib/apt/lists/*
COPY . .
# Hermetic build: stand up a throwaway Postgres on the committed build-cluster address
# (127.0.0.1:54321, user postgres / trust auth), then build. Each crate's build.rs provisions
# its own per-worktree database against it and verifies SQL at compile time; the server is
# stopped before the layer closes so nothing leaks into the runtime image. `--auth=trust`
# accepts the `postgres:password@…:54321` URL the build scripts default to (password ignored).
# The `saas` feature pulls the S3 ObjectStore + the Kubernetes backend crates.
RUN set -eux; \
    PGBIN="$(ls -d /usr/lib/postgresql/*/bin | head -1)"; \
    mkdir -p /pgbuild && chown postgres:postgres /pgbuild; \
    su postgres -c "$PGBIN/initdb --auth=trust --username=postgres -D /pgbuild"; \
    su postgres -c "$PGBIN/pg_ctl -D /pgbuild -w -o '-p 54321 -c listen_addresses=127.0.0.1' start"; \
    su postgres -c "psql -h 127.0.0.1 -p 54321 -U postgres -d postgres -c \"ALTER USER postgres PASSWORD 'password';\""; \
    export DATABASE_URL="postgresql://postgres:password@127.0.0.1:54321/postgres"; \
    if [ "$WORKER_PROFILE" = "debug" ]; then \
      cargo build -p cytoanalyst --features saas --bin cytoanalyst; \
    else \
      cargo build --release -p cytoanalyst --features saas --bin cytoanalyst; \
    fi; \
    su postgres -c "$PGBIN/pg_ctl -D /pgbuild -w stop"; \
    rm -rf /pgbuild

# ---- runtime ----
FROM debian:bookworm-slim
ARG WORKER_PROFILE=release
RUN apt-get update && apt-get install -y --no-install-recommends \
    bubblewrap squashfuse fuse3 ca-certificates && rm -rf /var/lib/apt/lists/*
# The builder writes to target/debug or target/release per WORKER_PROFILE; copy the right one.
COPY --from=builder /src/target/${WORKER_PROFILE}/cytoanalyst /usr/local/bin/cytoanalyst
# The env-rootfs cache lives here (shared content-addressed mount; GHCR only on miss).
ENV CYTO_APP_DATA_DIR=/var/lib/cytoanalyst
RUN mkdir -p /var/lib/cytoanalyst /var/lib/cytoanalyst/env-rootfs

# ── env-rootfs delivery (deploy-hardening gap #5) ─────────────────────────────────────────
# The worker resolves its sandbox rootfs from CYTO_ENV_ROOTFS_SQUASHFS (air-gap seam 1 — the
# release-safe path; it is NOT debug-gated) at the canonical in-pod path below, and uses
# CYTO_SANDBOX_ENV_ID as the deployment-default env-id when the extension registry has not yet
# declared one. The scaffold delivers the squashfs into this path via an initContainer + a
# shared volume (default), OR the image bakes it via the ROOTFS_SQUASHFS build-arg (below).
ENV CYTO_ENV_ROOTFS_SQUASHFS=/var/lib/cytoanalyst/env-rootfs/rootfs.squashfs
ENV CYTO_SANDBOX_ENV_ID=cyto-default
# Bake-at-build (alternative delivery, documented in the README): to embed the squashfs in the
# image instead of delivering it at runtime, add ONE line here —
#     COPY <ctx-relative>/rootfs.squashfs /var/lib/cytoanalyst/env-rootfs/rootfs.squashfs
# with the file present in the build context (obtained with a read:packages token). The default
# build stays clean (no bake); the initContainer+volume path in the scaffold is the default.
# The worker claims jobs; no public router (ITEM-2). DB + jwt + secrets config arrive via a
# mounted YAML the CONFIG_FILE env points at (a k8s Secret) — never baked into the image. AWS_*
# static creds + CYTO_WORKSTORE_* may arrive via env; a CUSTOM S3 endpoint in a --release worker
# must come from the DB infra_object_store row (#63, release-safe), NOT the debug S3_ENDPOINT env.
ENTRYPOINT ["cytoanalyst", "worker"]
