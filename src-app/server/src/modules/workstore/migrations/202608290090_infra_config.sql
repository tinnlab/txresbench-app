-- Infrastructure backend config (#63) — the admin-configurable,
-- ENCRYPTED-at-rest config for the object-store (S3/GCS) and compute
-- (Kubernetes) backends, promoting the 12-factor env selection
-- (TXR_WORKSTORE_BACKEND / S3_* / AWS_* ; KUBECONFIG / TXR_K8S_NAMESPACE /
-- TXR_WORKER_IMAGE) to singleton DB rows an admin can set/rotate + test
-- through the UI — SQLite dialect port (ITEM-9, sqlite-store) of
-- `src/modules/workstore/migrations/202608290090_infra_config.sql`.
--
-- SECURITY (#60/#63 precedent with the pgcrypto reference DROPPED — see the
-- port note): the cloud/cluster CREDENTIALS (S3 access-key/secret-key;
-- kubeconfig/cluster-token) are stored ENCRYPTED at rest as ciphertext
-- bytes via `txresbench_framework::secret::encrypt_secret` (keyed by
-- `secrets.storage_key`). The plaintext is NEVER stored in a column, NEVER
-- returned by the GET (masked view only), NEVER logged; read back via
-- `decrypt_secret`. When `secrets.storage_key` is unset the app runs in
-- compat mode: no DB secret storage (a PUT with a secret is refused 400),
-- env fallback (byte-identical).
--
-- PORT NOTE — the pgcrypto finding (DEC-10 / PLAN "Amendment — owner
-- decision D02"): the Postgres file says "pgcrypto is already enabled by
-- 202608290080 (`CREATE EXTENSION IF NOT EXISTS pgcrypto`)". That extension
-- migration was deleted with the billing module (strip commit e38a55d), so
-- the PG chain today references an extension that does not exist anywhere in
-- the tree — the `encrypt_secret`/`decrypt_secret` runtime path is already
-- broken when `storage_key` is set. The SQLite port drops every pgcrypto /
-- `pgp_sym_*` reference by construction: no `CREATE EXTENSION`, no SQL-side
-- cipher. The secret feature itself stays DORMANT per owner decision D02 —
-- `encrypt_secret`/`decrypt_secret` keep their names and `storage_key`
-- semantics and return an explicit "secrets unavailable" error when called
-- (no new cipher is built by this node); the ciphertext COLUMNS below stay
-- `BLOB`-mapped (bytea -> BLOB) so the readers/writers keep operating on
-- the same column types.
--
-- SQLite port notes (ITEM-9, DEC-8 type map): `boolean` -> INTEGER 0/1,
-- `bytea` -> BLOB, `uuid` -> BLOB, `timestamptz DEFAULT now()` -> TEXT
-- RFC3339 UTC (`strftime(...)` default), no `public.` prefix; the CREATE
-- TABLE IF NOT EXISTS + inline `singleton` CHECK + seeded singleton rows
-- are direct ports (constraint names preserved verbatim).

-- ── object-store backend config ────────────────────────────────────────────
CREATE TABLE infra_object_store (
    singleton              INTEGER PRIMARY KEY DEFAULT 1,
    -- Backend selection (plaintext): 'local' | 's3'. NULL ⇒ fall back to
    -- TXR_WORKSTORE_BACKEND env (compat mode).
    backend                TEXT,
    -- Cloud provider when backend='s3' (plaintext): 's3' | 'gcs'.
    provider               TEXT,
    -- Endpoint override (plaintext, e.g. a MinIO/R2/fake-gcs URL). NULL ⇒ provider default.
    endpoint               TEXT,
    bucket                 TEXT,
    region                 TEXT,
    -- Path-style addressing (minio/R2 need it; real AWS uses virtual-hosted).
    path_style             INTEGER,
    -- Encrypted S3 access-key-id ciphertext; NULL when unconfigured.
    access_key_ciphertext  BLOB,
    -- Encrypted S3 secret-access-key ciphertext; NULL when unconfigured.
    secret_key_ciphertext  BLOB,
    -- Audit: the acting admin's user id + last-write time.
    updated_by             BLOB,
    updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT infra_object_store_singleton_check CHECK (singleton = 1)
);

INSERT INTO infra_object_store (singleton)
VALUES (1)
ON CONFLICT (singleton) DO NOTHING;

-- ── compute backend config ──────────────────────────────────────────────────
CREATE TABLE infra_compute (
    singleton              INTEGER PRIMARY KEY DEFAULT 1,
    -- Backend selection (plaintext): 'local' | 'kubernetes'. NULL ⇒ env default.
    backend                TEXT,
    -- Cluster API endpoint (plaintext, informational/display).
    cluster_endpoint       TEXT,
    -- Kubernetes namespace (plaintext). NULL ⇒ TXR_K8S_NAMESPACE env / 'default'.
    namespace              TEXT,
    -- Worker/job image (plaintext). NULL ⇒ TXR_WORKER_IMAGE env.
    worker_image           TEXT,
    -- Encrypted kubeconfig ciphertext; NULL when unconfigured.
    kubeconfig_ciphertext  BLOB,
    -- Encrypted cluster bearer-token ciphertext; NULL when unconfigured.
    token_ciphertext       BLOB,
    -- Audit.
    updated_by             BLOB,
    updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT infra_compute_singleton_check CHECK (singleton = 1)
);

INSERT INTO infra_compute (singleton)
VALUES (1)
ON CONFLICT (singleton) DO NOTHING;
