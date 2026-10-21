-- Infrastructure backend config (#63) — the admin-configurable, ENCRYPTED-at-rest
-- config for the object-store (S3/GCS) and compute (Kubernetes) backends,
-- promoting the 12-factor env selection (CYTO_WORKSTORE_BACKEND / S3_* / AWS_* ;
-- KUBECONFIG / CYTO_K8S_NAMESPACE / CYTO_WORKER_IMAGE) to singleton DB rows an
-- admin can set/rotate + test through the UI.
--
-- SECURITY (mirrors billing_integration 202608290080, the #60 precedent): the
-- cloud/cluster CREDENTIALS (S3 access-key/secret-key; kubeconfig/cluster-token)
-- are stored ENCRYPTED as `bytea` ciphertext via `ziee_framework::secret::
-- encrypt_secret` (pgcrypto `pgp_sym_encrypt`, keyed by `secrets.storage_key`).
-- The plaintext is NEVER stored in a column, NEVER returned by the GET (masked
-- view only), NEVER logged. Read back via `decrypt_secret`. When
-- `secrets.storage_key` is unset the app runs in compat mode: no DB secret
-- storage (a PUT with a secret is refused 400), env fallback (byte-identical).
--
-- pgcrypto is already enabled by 202608290080 (`CREATE EXTENSION IF NOT EXISTS
-- pgcrypto`); this migration does not re-declare it (applied in BOTH build
-- profiles regardless of the `saas` feature — a migration cannot be cfg-gated;
-- only the ROUTE/handler is saas-gated).
--
-- Non-secret operator config (backend selection, provider, endpoint, bucket,
-- region, path_style; namespace, worker_image, cluster_endpoint) is PLAINTEXT
-- (mirrors billing_integration.price_ids). Each table is a `singleton boolean
-- PRIMARY KEY` pinned true by a CHECK so exactly one row exists.

-- ── object-store backend config ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.infra_object_store (
    singleton              boolean PRIMARY KEY DEFAULT true,
    -- Backend selection (plaintext): 'local' | 's3'. NULL ⇒ fall back to
    -- CYTO_WORKSTORE_BACKEND env (compat mode).
    backend                text,
    -- Cloud provider when backend='s3' (plaintext): 's3' | 'gcs'.
    provider               text,
    -- Endpoint override (plaintext, e.g. a MinIO/R2/fake-gcs URL). NULL ⇒ provider default.
    endpoint               text,
    bucket                 text,
    region                 text,
    -- Path-style addressing (minio/R2 need it; real AWS uses virtual-hosted).
    path_style             boolean,
    -- Encrypted (pgp_sym_encrypt) S3 access-key-id ciphertext; NULL when unconfigured.
    access_key_ciphertext  bytea,
    -- Encrypted S3 secret-access-key ciphertext; NULL when unconfigured.
    secret_key_ciphertext  bytea,
    -- Audit: the acting admin's user id + last-write time.
    updated_by             uuid,
    updated_at             timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT infra_object_store_singleton_check CHECK (singleton = true)
);

INSERT INTO public.infra_object_store (singleton)
VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

-- ── compute backend config ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.infra_compute (
    singleton              boolean PRIMARY KEY DEFAULT true,
    -- Backend selection (plaintext): 'local' | 'kubernetes'. NULL ⇒ env default.
    backend                text,
    -- Cluster API endpoint (plaintext, informational/display).
    cluster_endpoint       text,
    -- Kubernetes namespace (plaintext). NULL ⇒ CYTO_K8S_NAMESPACE env / 'default'.
    namespace              text,
    -- Worker/job image (plaintext). NULL ⇒ CYTO_WORKER_IMAGE env.
    worker_image           text,
    -- Encrypted (pgp_sym_encrypt) kubeconfig ciphertext; NULL when unconfigured.
    kubeconfig_ciphertext  bytea,
    -- Encrypted cluster bearer-token ciphertext; NULL when unconfigured.
    token_ciphertext       bytea,
    -- Audit.
    updated_by             uuid,
    updated_at             timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT infra_compute_singleton_check CHECK (singleton = true)
);

INSERT INTO public.infra_compute (singleton)
VALUES (true)
ON CONFLICT (singleton) DO NOTHING;
