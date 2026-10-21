//! S3 / native-GCS object-store backend (T2, epic compute-storage).
//!
//! The `ObjectStore` `get_range` primitive is S3-byte-range-shaped from day one, so the
//! cloud backend is a drop-in with the SAME content keys (`sha256:<hex>`) and the SAME
//! merkle identity as `local_fs` — only the byte substrate differs (INV-5).
//!
//! **Two builds, one seam.** The real backend links the `object_store` crate (S3 + native
//! GCS) and is compiled ONLY behind the `saas` cargo feature (INV-4 — the desktop/default
//! binary never links a cloud SDK). Without `saas`, this file is a compiled STUB whose
//! bodies are never reached at runtime (the selector refuses `s3` in a non-saas build), so
//! `S3Store` still exists for the trait-default `link_blob` probe. The `object_store` crate
//! is a dependency of THIS file alone (INV-1); no bucket handle leaks into handlers, ingest,
//! gc, sandbox or jobs (asserted by the import-graph guard, TEST-7).
//!
//! # AMBIENT-IDENTITY REACHABILITY MATRIX (#72)
//!
//! Read this before concluding that a federated identity "already works". `object_store`'s
//! credential chain is selected by BUILDER FIELDS, and its `new()` constructors are
//! `Default::default()` — the AWS builder reads no environment at all. Until #72 this file
//! called only `new()`, so every pod-injected AWS identity variable was discarded and the
//! chain fell through to `InstanceCredentialProvider` — **the EC2 node role**, an identity
//! shared by every pod on that node. It did not fail; it silently used the wrong credential.
//! `from_conn` now seeds each builder from the ambient identity environment before applying
//! the app's own settings, and REFUSES a half-configured federated identity rather than
//! letting it fall through.
//!
//! Verified against the PINNED `object_store` **0.13.2** (`Cargo.lock`); an upgrade must
//! re-check this table.
//!
//! | Path | Inputs | Reachable |
//! |---|---|---|
//! | AWS IRSA / AssumeRoleWithWebIdentity | `AWS_ROLE_ARN` + `AWS_WEB_IDENTITY_TOKEN_FILE` (+ `AWS_ROLE_SESSION_NAME`) | **yes** (since #72) |
//! | AWS EKS Pod Identity | `AWS_CONTAINER_CREDENTIALS_FULL_URI` (link-local host only) + `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE` | **yes** (since #72) |
//! | AWS ECS task role | `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` | **yes** (since #72) |
//! | AWS static / emulator creds | `S3ConnConfig.access_key_id`/`secret_access_key` | yes (pre-existing; **wins over every federated arm**) |
//! | AWS EC2 instance role (IMDS) | none — the crate's fallthrough | yes (last resort, NOT pod-scoped) |
//! | GKE Workload Identity | **none** — needs no variable and no builder field | yes (pre-existing, NOT new in #72) |
//! | GCP ADC (`service_account` / `authorized_user`) | `GOOGLE_APPLICATION_CREDENTIALS` | **yes** (since #72) |
//! | **GCP Workload Identity FEDERATION** (`external_account`) | `GOOGLE_APPLICATION_CREDENTIALS` → an `external_account` doc | **NO — unsupported by the pinned crate** |
//!
//! **What #72 actually changed per cloud, stated precisely so the table is not read as more
//! than it is.** On AWS it made three federated arms reachable that were previously dead
//! code, and added a refusal for the half-configured case. On GCP it made the ADC pointer
//! reachable and turned an unusable WIF credential into a loud refusal — but it did NOT
//! improve GKE Workload Identity, which never needed anything: WI is the crate's
//! metadata-server fallthrough and worked before this change. The GCP allowlist is
//! deliberately ONE entry; see `gcp_identity_env` for why every service-account-key
//! spelling is excluded.
//!
//! **The metadata-server fallthrough is not one thing.** On GKE with Workload Identity
//! enabled, `gke-metadata-server` intercepts it and returns a POD-scoped token — correct
//! behaviour. On GCE, or on GKE without WI, the same call returns the NODE's service
//! account. Both statements appear below in context; neither is true unconditionally.
//!
//! **Two GCP env reads live BEHIND the builder, where no allowlist here can reach them.**
//! `ApplicationDefaultCredentials::read(None)` probes `$HOME/.config/gcloud/…` via
//! `env::var_os` at build time, and `InstanceCredentialProvider::fetch_token` reads
//! `GCE_METADATA_HOST` / `GCE_METADATA_ROOT` / `GCE_METADATA_IP` at token-fetch time. The
//! second means the GKE Workload-Identity endpoint IS env-redirectable by a variable this
//! file can neither admit nor exclude. That is a property of the crate, not of this change,
//! and it is recorded here because the sentence "the builder reads no environment" is exact
//! for AWS and would be false if said of GCP.
//!
//! The `external_account` row is a real gap, not an oversight: `ApplicationDefaultCredentials`
//! (`object_store-0.13.2 src/gcp/credential.rs:546-559`) deserializes only `service_account`
//! and `authorized_user`, so the document GCP WIF issues cannot be consumed no matter which
//! constructor is called. Rather than let it fall through, [`real::unsupported_gcp_adc`]
//! turns it into a loud, operator-actionable refusal (DEC-4/DEC-5). Closing it needs an
//! upstream crate change or a hand-written `GcpCredentialProvider`; deliberately NOT
//! attempted here.
//!
//! What is machine-checked locally and what is not: the tests below prove the environment
//! REACHES the builder and that the federated arm is the one SELECTED. They do not — and by
//! design §12a cannot — prove a live STS/IRSA token exchange; that leg runs only in-cloud, and
//! `scripts/cloud-sim-guard.sh` keeps this box credential-free so the distinction stays honest.

// ─────────────────────────────────────────────────────────────────────────────
// STUB — the desktop/default build (no `saas`). No `object_store` dep is linked.
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(not(feature = "saas"))]
mod stub {
    #![allow(dead_code)]
    use async_trait::async_trait;
    use std::collections::HashSet;
    use ziee_core::AppError;

    use super::super::{ByteStream, ContentKey, GcReport, MultiFilePut, ObjectStat, ObjectStore};

    /// Placeholder cloud store. In a non-`saas` build the `s3` backend is never
    /// constructed (the selector refuses it), so these bodies are unreachable; the type
    /// exists only so the trait-default `link_blob` probe compiles + answers `Unsupported`.
    pub struct S3Store {
        _bucket: String,
    }

    impl S3Store {
        pub fn new(bucket: impl Into<String>) -> Self {
            Self {
                _bucket: bucket.into(),
            }
        }
    }

    #[async_trait]
    impl ObjectStore for S3Store {
        async fn put(&self, _bytes: &[u8]) -> Result<ContentKey, AppError> {
            unimplemented!("S3 backend requires the `saas` build")
        }
        async fn put_prefix(
            &self,
            _members: &[(String, Vec<u8>)],
        ) -> Result<MultiFilePut, AppError> {
            unimplemented!("S3 backend requires the `saas` build")
        }
        async fn get(&self, _key: &ContentKey) -> Result<Vec<u8>, AppError> {
            unimplemented!("S3 backend requires the `saas` build")
        }
        async fn get_range(
            &self,
            _key: &ContentKey,
            _offset: u64,
            _length: u64,
        ) -> Result<Vec<u8>, AppError> {
            unimplemented!("S3 backend requires the `saas` build")
        }
        async fn get_stream(
            &self,
            _key: &ContentKey,
            _offset: u64,
            _length: u64,
        ) -> Result<ByteStream, AppError> {
            unimplemented!("S3 backend requires the `saas` build")
        }
        // NOTE — no `link_blob` override (artifact-model ITEM-16). Its trait default is
        // `BlobLink::Unsupported`, the CORRECT + permanent answer for a remote backend:
        // S3/GCS objects are not local filesystem entries, so a caller staging a job input
        // must copy. Kept defaulted in BOTH builds (TEST-6).
        async fn stat(&self, _key: &ContentKey) -> Result<ObjectStat, AppError> {
            unimplemented!("S3 backend requires the `saas` build")
        }
        async fn exists(&self, _key: &ContentKey) -> Result<bool, AppError> {
            unimplemented!("S3 backend requires the `saas` build")
        }
        async fn delete(&self, _key: &ContentKey) -> Result<(), AppError> {
            unimplemented!("S3 backend requires the `saas` build")
        }
        async fn resolve_member(
            &self,
            _manifest_key: &ContentKey,
            _member_path: &str,
        ) -> Result<ContentKey, AppError> {
            unimplemented!("S3 backend requires the `saas` build")
        }
        async fn gc(
            &self,
            _keep: &HashSet<String>,
            _min_age_secs: u64,
        ) -> Result<GcReport, AppError> {
            unimplemented!("S3 backend requires the `saas` build")
        }
        async fn list_keys(&self) -> Result<Vec<ContentKey>, AppError> {
            unimplemented!("S3 backend requires the `saas` build")
        }
    }
}
#[cfg(not(feature = "saas"))]
pub use stub::S3Store;

// ─────────────────────────────────────────────────────────────────────────────
// REAL — the `saas` build. The `object_store` crate (S3 + native GCS) lives here.
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(feature = "saas")]
mod real {
    use std::collections::HashSet;
    use std::sync::Arc;
    use std::time::Duration;

    use async_trait::async_trait;
    use bytes::Bytes;
    use chrono::Utc;
    use futures_util::StreamExt;
    use object_store::aws::{AmazonS3Builder, AmazonS3ConfigKey};
    use object_store::gcp::{GoogleCloudStorageBuilder, GoogleConfigKey};
    use object_store::path::Path as OsPath;
    use object_store::{
        ClientOptions, GetOptions, GetRange, MultipartUpload, ObjectStore as CloudStore,
        ObjectStoreExt, PutPayload, RetryConfig,
    };
    use ziee_core::AppError;

    use super::super::{
        decode_manifest, encode_manifest, merkle_root, sha256_hex, ByteStream, ContentKey,
        GcReport, MemberRef, MultiFilePut, ObjectStat, ObjectStore,
    };
    use crate::modules::workstore::config::{CloudProvider, S3ConnConfig};

    /// The bucket prefix every content-addressed blob (data / member / manifest) lives
    /// under. A flat keyspace under one prefix; `gc`'s `list` walks exactly this prefix and
    /// maps each object name back to its `ContentKey`.
    const BLOB_PREFIX: &str = "blobs";

    // ── ambient cloud identity (#72) ────────────────────────────────────────────────
    //
    // `AmazonS3Builder::new()` / `GoogleCloudStorageBuilder::new()` are
    // `Default::default()`: the BUILDER reads no environment. The crate's env-reading
    // constructors are `from_env()`, and this file never called them — so a pod's
    // injected IRSA / Pod-Identity / ADC variables were discarded and the AWS chain fell
    // through to the EC2 instance-metadata provider (the NODE role). See the reachability
    // matrix in this module's doc comment.
    //
    // "The builder reads no environment" is exact for AWS and NOT exact for GCP: the GCS
    // credential PROVIDERS read env behind the builder, where no allowlist here can reach
    // them — `ApplicationDefaultCredentials::read(None)` probes `$HOME/.config/gcloud/…`
    // via `env::var_os` at build time, and `InstanceCredentialProvider::fetch_token` reads
    // `GCE_METADATA_HOST` / `_ROOT` / `_IP` at token-fetch time. Both are documented in the
    // matrix because the second one means the GKE Workload-Identity endpoint is
    // env-redirectable by a variable this file can neither admit nor exclude.
    //
    // WHY AN ALLOWLIST AND NOT `from_env()` (DEC-1). In 0.13.2 `from_env()` evaluates EVERY
    // `AWS_*` variable, including `aws_endpoint`, `aws_endpoint_url_s3`,
    // `aws_skip_signature`, `aws_metadata_endpoint`, `aws_s3_express` and
    // `aws_unsigned_payload`. `config.rs` confines the endpoint override to a
    // `#[cfg(debug_assertions)]` seam (`endpoint_seam`, DEC-3) precisely so a RELEASE
    // binary cannot be redirected at another store; honouring `AWS_ENDPOINT` would reopen
    // that, and `AWS_SKIP_SIGNATURE` would let the environment turn signing off.
    //
    // The allowlist is what protects those fields — NOT the fact that the app's own
    // setters run afterwards. Bucket, region, retry, client options and addressing style
    // are safe because their keys are ABSENT below; saying "the later setters win" would
    // be a true but empty reassurance, since there is nothing to win against.
    //
    // TWO ENTRIES CARRY A URL, AND BOTH ARE CONSTRAINED. An identity allowlist that
    // admits an arbitrary endpoint is worse than an endpoint allowlist, because what
    // travels to that endpoint is the credential itself: `AWS_ENDPOINT_URL_STS` would be
    // the POST target for the pod's projected service-account JWT, and
    // `AWS_CONTAINER_CREDENTIALS_FULL_URI` is a plaintext-HTTP target that receives the
    // contents of `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE` and returns credentials we then
    // adopt. So `AWS_ENDPOINT_URL_STS` is NOT admitted at all (a custom/VPC STS endpoint is
    // a config-plane change, DEC-9), and `AWS_CONTAINER_CREDENTIALS_FULL_URI` is admitted
    // only when its host is link-local or loopback — which is what real EKS Pod Identity
    // uses (`169.254.170.23`) and what an exfiltration target cannot be.

    /// A non-empty environment read. Mirrors `config.rs::env_opt` — an empty string is
    /// treated as unset, because a Kubernetes `env:` entry with no value materialises as
    /// `""` and must not be mistaken for a configured credential.
    fn env_opt(key: &str) -> Option<String> {
        std::env::var(key).ok().filter(|v| !v.is_empty())
    }

    /// The AWS **identity** allowlist (DEC-1): the environment variables that feed the
    /// `object_store` credential chain, and nothing else. Ordered as the chain evaluates
    /// them, so the table reads against `object_store-0.13.2 src/aws/builder.rs:1090-1180`.
    ///
    /// Every entry here is asserted, in both directions, by TEST-1 — which drives itself
    /// from this table rather than from a hand-copied list, so an added row cannot escape
    /// coverage. TEST-3 asserts the table against a denylist, so an added ENDPOINT or
    /// SIGNING key fails structurally rather than on someone noticing.
    pub(crate) fn aws_identity_env() -> &'static [(&'static str, AmazonS3ConfigKey)] {
        &[
            // IRSA / AssumeRoleWithWebIdentity — the EKS pod-identity path. The first two
            // are REQUIRED TOGETHER: the crate's arm is
            // `if let (Some(token_path), Some(role_arn))` (builder.rs:1107), so one alone
            // silently does nothing and the chain continues to IMDS. `from_conn` refuses
            // that half-configured state rather than letting it fall through.
            (
                "AWS_WEB_IDENTITY_TOKEN_FILE",
                AmazonS3ConfigKey::WebIdentityTokenFile,
            ),
            ("AWS_ROLE_ARN", AmazonS3ConfigKey::RoleArn),
            ("AWS_ROLE_SESSION_NAME", AmazonS3ConfigKey::RoleSessionName),
            // ECS task role. Safe unconditionally: the crate pins this to
            // `http://169.254.170.2{uri}` (builder.rs:1141), so the host is not ours to
            // validate and cannot be moved.
            (
                "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
                AmazonS3ConfigKey::ContainerCredentialsRelativeUri,
            ),
            // EKS Pod Identity — also both-or-nothing, and FULL_URI is host-validated by
            // `ambient_aws_identity_refusal` before it is applied.
            (
                "AWS_CONTAINER_CREDENTIALS_FULL_URI",
                AmazonS3ConfigKey::ContainerCredentialsFullUri,
            ),
            (
                "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
                AmazonS3ConfigKey::ContainerAuthorizationTokenFile,
            ),
        ]
    }

    /// Config keys the identity allowlist must NEVER admit: the data endpoint, the
    /// credential endpoint, the metadata endpoint, and the signing switches. TEST-3
    /// asserts `aws_identity_env()` and this list are disjoint, so switching to
    /// `from_env()` — or adding an endpoint key "just for this one deployment" — fails a
    /// test rather than a review.
    #[cfg(test)]
    pub(crate) const AWS_FORBIDDEN_AMBIENT_KEYS: &[AmazonS3ConfigKey] = &[
        AmazonS3ConfigKey::Endpoint,
        AmazonS3ConfigKey::S3Endpoint,
        AmazonS3ConfigKey::StsEndpoint,
        AmazonS3ConfigKey::MetadataEndpoint,
        AmazonS3ConfigKey::SkipSignature,
        AmazonS3ConfigKey::UnsignedPayload,
        AmazonS3ConfigKey::S3Express,
        AmazonS3ConfigKey::ImdsV1Fallback,
        // The static key pair and its session token come from `S3ConnConfig`, never from
        // the ambient environment: folding an ambient `AWS_SESSION_TOKEN` onto a key pair
        // that may have been decrypted from the admin DB row is cross-source credential
        // mixing, and `S3ConnConfig` has no session-token field to pair it with (DEC-9).
        AmazonS3ConfigKey::Token,
        AmazonS3ConfigKey::AccessKeyId,
        AmazonS3ConfigKey::SecretAccessKey,
    ];

    /// The GCP **identity** allowlist (DEC-1), deliberately a single entry.
    ///
    /// `GOOGLE_SERVICE_ACCOUNT`, `GOOGLE_SERVICE_ACCOUNT_PATH`, `SERVICE_ACCOUNT` and
    /// `GOOGLE_SERVICE_ACCOUNT_KEY` are NOT admitted, for two independent reasons:
    ///
    /// 1. **They can move the data endpoint and switch auth off in a release build.** A
    ///    service-account DOCUMENT carries `gcs_base_url` and `disable_oauth`
    ///    (`gcp/credential.rs:322-342`), and `build()` resolves the effective base URL as
    ///    `self.base_url.or_else(|| document.gcs_base_url)`. In a release binary
    ///    `cfg.endpoint` is always `None` — that is exactly what `endpoint_seam`
    ///    guarantees — so the document's value wins unconditionally. Admitting these would
    ///    hand the ambient environment the very redirect DEC-3 exists to prevent, just
    ///    through a JSON field instead of a config key.
    /// 2. **`SERVICE_ACCOUNT` is an unnamespaced name that Kubernetes charts already use**
    ///    for a service-account NAME, not a path. A collision would make
    ///    `ServiceAccountCredentials::from_file` fail and refuse the whole backend on a
    ///    cluster that was previously coming up fine.
    ///
    /// Nothing is lost against the design: §7.1's GCP mechanism is **GKE Workload
    /// Identity**, which needs no builder field and no variable at all — it is the crate's
    /// metadata-server fallthrough, it worked before #72, and it is untouched here. Every
    /// dropped entry was a STATIC PRIVATE KEY, i.e. precisely the "static secret riding
    /// config" §7.1 forbids. What remains is the standard ADC pointer, which does not feed
    /// `gcs_base_url` and which is what makes the WIF refusal below possible.
    pub(crate) fn gcp_identity_env() -> &'static [(&'static str, GoogleConfigKey)] {
        &[(
            "GOOGLE_APPLICATION_CREDENTIALS",
            GoogleConfigKey::ApplicationCredentials,
        )]
    }

    /// Whether a URL names a host we are willing to fetch a CREDENTIAL from: link-local
    /// (169.254.0.0/16) or loopback, over an explicit scheme.
    ///
    /// This is a security boundary, not a convenience check, so it is written to be
    /// defeated only by something the HTTP client would also refuse. Three classes of
    /// evasion are handled explicitly, and each is here because a real parser disagrees
    /// with the naive reading:
    ///
    /// 1. **Authority delimiters.** An authority ends at the first `/`, `?` **or** `#`.
    ///    Stripping only `/` lets `http://evil.example?@127.0.0.1` present `127.0.0.1` to
    ///    a validator while `http::uri::Authority` — which is what the crate's client
    ///    parses — sends the request to `evil.example`.
    /// 2. **Userinfo.** `http://169.254.170.2@evil.example` has host `evil.example`; the
    ///    link-local text is a username. Strip up to and including the LAST `@`.
    /// 3. **Non-decimal IPv4.** WHATWG's IPv4 parser reads a part with a leading `0` as
    ///    OCTAL, so `0127.0.0.1` is `87.0.0.1` — a public address — while
    ///    `"0127".parse::<u8>()` in Rust happily returns `127`. `parse::<u8>()` also
    ///    accepts a leading `+`. Each octet is therefore required to be 1-3 ASCII digits
    ///    with no leading zero (bare `0` excepted) before it is parsed.
    ///
    /// `scripts/cloud-sim-guard.sh::is_loopback` carries the same discipline for classes
    /// 1-2 (its own comment records being defeated by exactly those), and shares the
    /// class-3 gap; this is deliberately stricter.
    pub(crate) fn is_local_credential_host(url: &str) -> bool {
        // Require an explicit scheme. A scheme-less value is not a URL the client can
        // resolve, and accepting one would mean validating a string that never becomes
        // the request we checked.
        let Some((scheme, rest)) = url.split_once("://") else {
            return false;
        };
        if !matches!(scheme.to_ascii_lowercase().as_str(), "http" | "https") {
            return false;
        }
        // The authority ends at the FIRST of `/`, `?`, `#` — matching how the request's
        // URI is actually parsed, not how it reads.
        let authority = rest
            .split(['/', '?', '#'])
            .next()
            .unwrap_or_default();
        // Userinfo up to and including the LAST `@`.
        let hostport = match authority.rfind('@') {
            Some(idx) => &authority[idx + 1..],
            None => authority,
        };
        let host = if let Some(after_bracket) = hostport.strip_prefix('[') {
            match after_bracket.split_once(']') {
                Some((inner, _)) => inner,
                None => return false,
            }
        } else {
            hostport.split(':').next().unwrap_or_default()
        };
        let host = host.to_ascii_lowercase();
        // A trailing dot is a legal FQDN form and must not turn a real host into a
        // 4-element split; it is only ever legal on a NAME, and the only names we accept
        // are loopback ones.
        let host = host.strip_suffix('.').unwrap_or(&host).to_string();

        if host == "localhost" {
            return true;
        }
        if host.starts_with("::") || host.contains(':') {
            // IPv6: accept only the unambiguous loopback literal. `::ffff:127.0.0.1` and
            // other mapped forms are deliberately refused — fail closed on a form we would
            // have to re-implement a parser to judge.
            return host == "::1";
        }

        let octets: Vec<&str> = host.split('.').collect();
        if octets.len() != 4 {
            return false;
        }
        let mut parsed = [0u8; 4];
        for (slot, raw) in parsed.iter_mut().zip(octets.iter()) {
            // 1-3 ASCII digits, no leading zero (bare "0" excepted), no sign. This is what
            // keeps `0127`, `00127` and `+127` — all of which `u8::from_str` accepts and
            // WHATWG reads differently — from being read as 127.
            if raw.is_empty() || raw.len() > 3 || !raw.bytes().all(|b| b.is_ascii_digit()) {
                return false;
            }
            if raw.len() > 1 && raw.starts_with('0') {
                return false;
            }
            match raw.parse::<u8>() {
                Ok(v) => *slot = v,
                Err(_) => return false,
            }
        }
        matches!(parsed, [127, _, _, _] | [169, 254, _, _])
    }

    /// A URL with any userinfo replaced, and bounded in length, for safe inclusion in an
    /// operator-facing error that reaches an HTTP body. The userinfo of a rejected
    /// credential URL is attacker-authored and may itself be a credential.
    fn redact_for_message(value: &str) -> String {
        let cleaned = match (value.find("://"), value.rfind('@')) {
            (Some(s), Some(at)) if at > s => {
                format!("{}://<redacted>@{}", &value[..s], &value[at + 1..])
            }
            _ => value.to_string(),
        };
        truncate_for_message(&cleaned, 200)
    }

    /// Bound any file- or environment-controlled string before it reaches an error body.
    fn truncate_for_message(value: &str, cap: usize) -> String {
        if value.chars().count() <= cap {
            return value.to_string();
        }
        let head: String = value.chars().take(cap).collect();
        format!("{head}… (truncated)")
    }

    /// An AWS region is interpolated by the crate straight into BOTH the data endpoint
    /// (`https://{bucket}.s3.{region}.amazonaws.com`) and — now that the web-identity arm
    /// is live — the STS endpoint (`https://sts.{region}.amazonaws.com`). So a region
    /// containing `/`, `@`, `.` or `:` moves the host of the endpoint that receives the
    /// pod's identity token. Real regions are `[a-z0-9-]+`.
    ///
    /// This check exists BECAUSE of #72: before the web-identity arm was reachable,
    /// nothing interpolated the region into a credential endpoint, so an unvalidated
    /// region was a data-plane concern only. Making the arm live created the credential
    /// -plane exposure, so closing it belongs in this change and not a later one.
    pub(crate) fn is_wellformed_aws_region(region: &str) -> bool {
        !region.is_empty()
            && region.len() <= 64
            && region
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    }

    /// Refuse an ambient AWS identity environment that would resolve to the WRONG identity
    /// silently, or to an attacker-chosen one. `None` ⇒ nothing to refuse.
    ///
    /// This is the fail-closed half of #72, and it is the half that matters most: the
    /// whole point of the issue is that a half-configured federated identity did not
    /// FAIL — it fell through to the EC2 node role and worked, with credentials shared by
    /// every pod on the node. Detecting that requires refusing, not documenting. Mirrors
    /// `config.rs::backend_from_env` (#69/#70): name the variable, say what is wrong, say
    /// what to do.
    ///
    /// It covers BOTH both-or-nothing pairs, not just IRSA. The crate's Pod-Identity arm
    /// is `if let (Some(full_uri), Some(token_file))`, exactly like the web-identity arm,
    /// so a half-configured pair there falls through to IMDS in the identical way — an
    /// asymmetry with no justification, and the sort of gap that survives review because
    /// the covered case reads as if it covered both.
    pub(crate) fn ambient_aws_identity_refusal(region: &str) -> Option<String> {
        fn pair_refusal(
            set_var: &str,
            missing_var: &str,
            hint: &str,
        ) -> String {
            format!(
                "{set_var} is set but {missing_var} is not. object_store requires BOTH to \
                 select that federated-identity arm, so this configuration would silently \
                 skip federated identity and fall through to the EC2 instance-metadata \
                 provider — the NODE role, shared by every pod on this node. {hint}"
            )
        }

        // IRSA / web identity.
        match (
            env_opt("AWS_ROLE_ARN"),
            env_opt("AWS_WEB_IDENTITY_TOKEN_FILE"),
        ) {
            (Some(_), None) => {
                return Some(pair_refusal(
                    "AWS_ROLE_ARN",
                    "AWS_WEB_IDENTITY_TOKEN_FILE",
                    "Set AWS_WEB_IDENTITY_TOKEN_FILE (the projected service-account token, \
                     normally mounted at \
                     /var/run/secrets/eks.amazonaws.com/serviceaccount/token), or unset \
                     AWS_ROLE_ARN to use the node role deliberately.",
                ));
            }
            (None, Some(_)) => {
                return Some(pair_refusal(
                    "AWS_WEB_IDENTITY_TOKEN_FILE",
                    "AWS_ROLE_ARN",
                    "Set AWS_ROLE_ARN to the role the service account is annotated with, or \
                     unset AWS_WEB_IDENTITY_TOKEN_FILE.",
                ));
            }
            _ => {}
        }

        // EKS Pod Identity — the same both-or-nothing shape, and the same silent
        // fallthrough when half-configured.
        match (
            env_opt("AWS_CONTAINER_CREDENTIALS_FULL_URI"),
            env_opt("AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE"),
        ) {
            (Some(_), None) => {
                return Some(pair_refusal(
                    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
                    "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
                    "Set AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE, or unset \
                     AWS_CONTAINER_CREDENTIALS_FULL_URI.",
                ));
            }
            (None, Some(_)) => {
                return Some(pair_refusal(
                    "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
                    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
                    "Set AWS_CONTAINER_CREDENTIALS_FULL_URI to the pod-identity agent \
                     endpoint, or unset AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE.",
                ));
            }
            _ => {}
        }

        if let Some(uri) = env_opt("AWS_CONTAINER_CREDENTIALS_FULL_URI") {
            if !is_local_credential_host(&uri) {
                return Some(format!(
                    "AWS_CONTAINER_CREDENTIALS_FULL_URI='{}' does not name a link-local or \
                     loopback host over http/https. That endpoint receives the contents of \
                     AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE and returns credentials this \
                     process would then use, so an arbitrary host there is both a \
                     token-exfiltration and a credential-injection path. Real EKS Pod \
                     Identity uses the link-local agent (169.254.170.23); refusing anything \
                     else.",
                    redact_for_message(&uri)
                ));
            }
        }

        // ECS task role. The crate builds this endpoint by STRING INTERPOLATION —
        // `format!("http://169.254.170.2{uri}")` at `src/aws/builder.rs:1143`, not a path
        // join — so a value beginning `@` or `.` moves the host, exactly like the
        // FULL_URI evasions above. An earlier round of this change asserted in a comment
        // that the crate "pins" this host and it therefore needed no validation. That was
        // FALSE, and it is the reason this validation composes the real interpolation
        // rather than reasoning about the variable in isolation. Note the crate evaluates
        // this arm BEFORE Pod Identity, so anyone able to set it wins over the checked one.
        if let Some(uri) = env_opt("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI") {
            let composed = format!("http://169.254.170.2{uri}");
            if !uri.starts_with('/') || !is_local_credential_host(&composed) {
                return Some(format!(
                    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI='{}' is not a plain absolute \
                     path. The crate interpolates it into \
                     `http://169.254.170.2<value>` without a path join, so a value \
                     starting with '@' or '.' moves the HOST of the endpoint this process \
                     fetches its AWS credentials from. It must begin with '/' and leave \
                     the host link-local.",
                    redact_for_message(&uri)
                ));
            }
        }

        if !is_wellformed_aws_region(region) {
            return Some(format!(
                "AWS_REGION='{}' is not a well-formed region. The region is interpolated \
                 directly into both the S3 endpoint and — since the web-identity arm \
                 became reachable — the STS endpoint the pod's identity token is POSTed \
                 to, so a region containing '/', '@', ':' or '.' moves that host. Regions \
                 are lowercase letters, digits and hyphens.",
                truncate_for_message(region, 64)
            ));
        }
        None
    }


    /// Seed an `AmazonS3Builder` from the pod's ambient AWS identity environment (ITEM-1).
    ///
    /// Reads `std::env` ITSELF rather than taking the values as arguments — that is what
    /// makes the test of it non-circular: a caller cannot pre-supply the value under test.
    /// Call `ambient_aws_identity_refusal` FIRST; this function assumes the environment has
    /// already been judged acceptable.
    pub(crate) fn with_ambient_aws_identity(mut b: AmazonS3Builder) -> AmazonS3Builder {
        for (var, key) in aws_identity_env() {
            if let Some(value) = env_opt(var) {
                // Re-validate the URL-bearing entries HERE, at the point of use. The
                // refusal above reads the environment once and this function reads it
                // again, so the value that was checked and the value that is applied are
                // two different reads. Nothing in production mutates the environment
                // today (every `set_var` in the tree is `#[cfg(test)]`), but the safety of
                // a credential boundary should not rest on an unenforced global — least of
                // all in a module whose own tests mutate the environment.
                let unsafe_url = match *key {
                    AmazonS3ConfigKey::ContainerCredentialsFullUri => {
                        !is_local_credential_host(&value)
                    }
                    AmazonS3ConfigKey::ContainerCredentialsRelativeUri => {
                        !value.starts_with('/')
                            || !is_local_credential_host(&format!("http://169.254.170.2{value}"))
                    }
                    _ => false,
                };
                if unsafe_url {
                    continue;
                }
                b = b.with_config(*key, value);
            }
        }
        b
    }

    /// Seed a `GoogleCloudStorageBuilder` from the pod's ambient GCP identity environment
    /// (ITEM-3). Same no-arguments discipline as the AWS half.
    pub(crate) fn with_ambient_gcp_identity(
        mut b: GoogleCloudStorageBuilder,
    ) -> GoogleCloudStorageBuilder {
        for (var, key) in gcp_identity_env() {
            if let Some(value) = env_opt(var) {
                b = b.with_config(*key, value);
            }
        }
        b
    }

    /// The only Application-Default-Credentials document types the pinned `object_store`
    /// 0.13.2 can deserialize (`src/gcp/credential.rs:546-559`).
    const SUPPORTED_GCP_ADC_TYPES: &[&str] = &["service_account", "authorized_user"];

    /// The ADC document is read only to EXPLAIN a failure, never to drive behaviour, so a
    /// bounded read is strictly correct and avoids stalling an async admin handler on a
    /// FIFO or an endless device.
    const GCP_ADC_HINT_READ_CAP: usize = 64 * 1024;

    /// If `GOOGLE_APPLICATION_CREDENTIALS` explains a GCS build failure, the
    /// operator-facing text; otherwise `None` (ITEM-5 / DEC-4).
    ///
    /// This is what makes GCP **Workload Identity Federation** fail LEGIBLY. A WIF
    /// credential is `external_account`; the crate's ADC reader has exactly two variants,
    /// so `build()` refuses it with a bare serde message. Before #72 the situation was
    /// worse than cryptic: `GOOGLE_APPLICATION_CREDENTIALS` never reached the builder, the
    /// file was ignored, and the chain fell through to the GCE metadata server — which on a
    /// cluster WITHOUT Workload Identity is the node's service account, so the deployment
    /// came up working on the wrong identity. Refusing loudly is the #69/#70 convention.
    ///
    /// Consulted ONLY on the `build()` error path, and ONLY from the arm that actually
    /// seeded the ADC pointer. It can therefore never cause a false refusal, never
    /// blame a variable the failing path did not read, and it degrades to silence on a
    /// future crate version that supports `external_account`.
    pub(crate) fn unsupported_gcp_adc() -> Option<String> {
        const VAR: &str = "GOOGLE_APPLICATION_CREDENTIALS";
        let path = env_opt(VAR)?;

        let text = match std::fs::File::open(&path) {
            Ok(file) => {
                use std::io::Read;
                let mut buf = String::new();
                // Bounded: this read only ever produces an explanation.
                if file
                    .take(GCP_ADC_HINT_READ_CAP as u64)
                    .read_to_string(&mut buf)
                    .is_err()
                {
                    return None;
                }
                buf
            }
            Err(e) => {
                // The most common WIF-adjacent misconfiguration is a pointer at a file
                // that was never mounted. Silence there would waste an operator's evening.
                return Some(format!(
                    "{VAR}='{path}' could not be opened ({e}). The object-store backend \
                     cannot resolve a Google identity from it. If this is a projected \
                     credential, check the volume is mounted in this pod; if you meant to \
                     use GKE Workload Identity, unset {VAR} so the node metadata server is \
                     used instead."
                ));
            }
        };

        let doc: serde_json::Value = serde_json::from_str(&text).ok()?;
        let kind = doc.get("type")?.as_str()?;
        if SUPPORTED_GCP_ADC_TYPES.contains(&kind) {
            return None;
        }
        // The type string comes from a file; truncate before it reaches an HTTP body.
        let kind: String = kind.chars().take(64).collect();
        Some(format!(
            "{VAR}='{path}' holds a '{kind}' credential, which the pinned object_store \
             0.13.2 cannot consume — its Application-Default-Credentials reader supports \
             only {}. GCP Workload Identity FEDERATION issues 'external_account' \
             credentials, so WIF is NOT reachable through this object-store backend. \
             Either use GKE Workload Identity (leave {VAR} UNSET — the node metadata \
             server then serves a pod-scoped token), or point {VAR} at a service-account \
             key. Refusing rather than falling through to whatever identity the metadata \
             server happens to offer.",
            SUPPORTED_GCP_ADC_TYPES.join(" | ")
        ))
    }


    /// A cloud content-addressed store over the `object_store` crate (S3 or native GCS).
    /// Holds ONE shared, retry/timeout-configured handle per process (coding-guidelines §2 /
    /// ITEM-1), constructed once in [`S3Store::from_conn`].
    pub struct S3Store {
        inner: Arc<dyn CloudStore>,
        /// Switch a `put` to `put_multipart` at/above this many bytes (DEC-4).
        multipart_threshold: usize,
        /// Multipart part size (DEC-4). Clamped ≥ 5 MiB by the config resolver.
        part_size: usize,
    }

    impl std::fmt::Debug for S3Store {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("S3Store")
                .field("multipart_threshold", &self.multipart_threshold)
                .field("part_size", &self.part_size)
                .finish()
        }
    }

    impl S3Store {
        /// A minimal, never-connected handle for the trait-default `link_blob` probe
        /// (the `object_store/mod.rs` test) — build-time only, issues no network I/O.
        /// The real construction path is [`S3Store::from_conn`].
        ///
        /// Stays on the bare `AmazonS3Builder::new()` ON PURPOSE (DEC-8): it resolves no
        /// credentials because it makes no request, so seeding it from the ambient
        /// environment would only make an unrelated unit test's behaviour depend on the
        /// box it runs on. The two constructors differ deliberately, not by oversight —
        /// see this module's ambient-identity matrix.
        pub fn new(bucket: impl Into<String>) -> Self {
            let inner = AmazonS3Builder::new()
                .with_bucket_name(bucket.into())
                .with_region("us-east-1")
                .with_allow_http(true)
                .build()
                .expect("a no-network S3 handle builds from a bucket name");
            Self {
                inner: Arc::new(inner),
                multipart_threshold: 16 * 1024 * 1024,
                part_size: 8 * 1024 * 1024,
            }
        }

        /// Construct the real backend from resolved connection config (ITEM-3/ITEM-4). The
        /// `object_store` handle is built ONCE here with a retry policy + connect/request
        /// timeouts (coding-guidelines §2). `build()` issues no network I/O — credentials
        /// (ambient identity or the static emulator creds) resolve lazily at request time.
        pub fn from_conn(cfg: &S3ConnConfig) -> Result<Self, AppError> {
            if cfg.bucket.trim().is_empty() {
                return Err(AppError::internal_error(
                    "workstore: s3 backend selected but CYTO_WORKSTORE_S3_BUCKET is empty",
                ));
            }
            let client_options = ClientOptions::new()
                .with_connect_timeout(Duration::from_secs(30))
                .with_timeout(Duration::from_secs(120))
                // Loopback emulators (floci / floci-gcp) speak http; the endpoint override is
                // a debug-only seam (resolved in config.rs), so a release binary that has no
                // loopback endpoint keeps https.
                .with_allow_http(cfg.endpoint.is_some());
            let retry = RetryConfig::default();

            let inner: Arc<dyn CloudStore> = match cfg.provider {
                CloudProvider::S3 => {
                    // AMBIENT IDENTITY FIRST (#72 / ITEM-1) — but only on the REAL-cloud
                    // arm. With an endpoint override present we are pointed at a local
                    // emulator, which authenticates with the static creds below; seeding
                    // there would let a developer's ambient AWS_ROLE_ARN steer a local
                    // test. This is the same carve-out the GCS arm takes (DEC-2); the two
                    // arms are now symmetric.
                    //
                    // Bucket, region, retry, client options and addressing style are safe
                    // from the environment because their keys are ABSENT from the
                    // allowlist — not because these setters run afterwards.
                    let base = match &cfg.endpoint {
                        Some(_) => AmazonS3Builder::new(),
                        None => {
                            // FAIL CLOSED before building. A half-configured IRSA pair, or
                            // a container-credentials endpoint pointing off-box, must
                            // refuse — not fall through to the node role, which is the
                            // exact silent-wrong-identity outcome #72 exists to end.
                            if let Some(refusal) = ambient_aws_identity_refusal(&cfg.region) {
                                return Err(AppError::internal_error(format!(
                                    "workstore: refusing to build the S3 backend — {refusal}"
                                )));
                            }
                            with_ambient_aws_identity(AmazonS3Builder::new())
                        }
                    };
                    let mut b = base
                        .with_bucket_name(&cfg.bucket)
                        .with_region(&cfg.region)
                        .with_retry(retry)
                        .with_client_options(client_options)
                        // path-style for floci/R2; virtual-hosted for real AWS.
                        .with_virtual_hosted_style_request(!cfg.path_style);
                    if let Some(ep) = &cfg.endpoint {
                        b = b.with_endpoint(ep.clone()).with_allow_http(true);
                    }
                    // THE CREDENTIAL CHAIN THIS ACTUALLY BUILDS, in the crate's own
                    // evaluation order (`object_store-0.13.2 src/aws/builder.rs:1090-1180`;
                    // the static-arm gate is at :1092, web identity :1107, ECS :1137, EKS
                    // Pod Identity :1149, IMDS :1165):
                    //   1. static key pair below (the emulator/test path) — wins when present;
                    //   2. web identity / IRSA — from AWS_WEB_IDENTITY_TOKEN_FILE + AWS_ROLE_ARN;
                    //   3. ECS task role — from AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
                    //   4. EKS Pod Identity — from AWS_CONTAINER_CREDENTIALS_FULL_URI +
                    //      AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE;
                    //   5. EC2 instance metadata (IMDS) — the fallthrough, and NOT pod-scoped.
                    // Arms 2-4 are reachable only because `with_ambient_aws_identity` above
                    // populated their builder fields. Until #72 nothing did, so absent static
                    // creds this ALWAYS landed on arm 5 — the node role — whatever the pod's
                    // service account said.
                    //
                    // NOTE that arm 1 still beats every federated arm, and `S3ConnConfig`
                    // sources it from `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` or from
                    // the admin DB row. So a leftover static key pair silently bypasses
                    // IRSA — the same shape of defect as #72, in the opposite direction.
                    // Changing that precedence is out of scope here (it is what the floci
                    // emulator tier depends on) and is escalated in HUMAN_FEEDBACK.
                    if let (Some(ak), Some(sk)) = (&cfg.access_key_id, &cfg.secret_access_key) {
                        b = b.with_access_key_id(ak).with_secret_access_key(sk);
                    }
                    Arc::new(b.build().map_err(|e| {
                        AppError::internal_error(format!("workstore: S3 backend build failed: {e}"))
                    })?)
                }
                CloudProvider::Gcs => {
                    // The endpoint override is the fork between "emulator, go anonymous"
                    // and "real GCS, resolve an ambient identity". Ambient GCP identity is
                    // seeded ONLY on the second arm (ITEM-3 / DEC-2).
                    //
                    // HONEST STATUS OF THIS CARVE-OUT: it is now DEFENCE IN DEPTH, not
                    // load-bearing. Its original reason was that the crate parses
                    // `service_account` files eagerly, before the explicit-credentials arm
                    // the anonymous provider wins — so a stray GOOGLE_SERVICE_ACCOUNT could
                    // fail an emulator build on a file it never needed. That reason died
                    // when those variables were dropped from the allowlist (DEC-9): the one
                    // surviving entry is the ADC pointer, and the crate skips ADC entirely
                    // when `self.credentials` is set, which the emulator arm always does.
                    // Kept because it makes the arms symmetric and costs nothing, and
                    // because a future allowlist entry could resurrect the original hazard
                    // — but a reader must not mistake it for the thing protecting the
                    // emulator path today. That is `.with_credentials(anon)` below.
                    let base = GoogleCloudStorageBuilder::new();
                    let mut b = match &cfg.endpoint {
                        Some(_) => base,
                        None => with_ambient_gcp_identity(base),
                    }
                    .with_bucket_name(&cfg.bucket)
                    .with_retry(retry)
                    .with_client_options(client_options);
                    if let Some(ep) = &cfg.endpoint {
                        // Native GCS pointed at the floci-gcp emulator: override the base URL and go
                        // ANONYMOUS. `with_skip_signature(true)` alone is not enough — it only
                        // skips SIGNED-URL generation; the crate would still resolve an OAuth
                        // token and, finding no ADC, fall through to the GCE metadata server
                        // (169.254.169.254) and time out. Supplying an explicit empty-bearer
                        // credential short-circuits that chain (the emulator needs no auth). In
                        // real GCS the endpoint is absent and ADC / Workload-Identity signs.
                        let anon: object_store::gcp::GcpCredentialProvider =
                            std::sync::Arc::new(object_store::StaticCredentialProvider::new(
                                object_store::gcp::GcpCredential {
                                    bearer: String::new(),
                                },
                            ));
                        b = b
                            .with_base_url(ep.as_str())
                            .with_credentials(anon)
                            .with_skip_signature(true);
                    }
                    // The ADC hint is consulted ONLY on the arm that seeded the ADC
                    // pointer. On the emulator arm `GOOGLE_APPLICATION_CREDENTIALS` was
                    // deliberately not read, so blaming it for a failure there would be a
                    // false explanation — accurate-sounding and wrong, which is worse than
                    // no explanation.
                    let seeded_adc = cfg.endpoint.is_none();
                    Arc::new(b.build().map_err(|e| {
                        // A GCP Workload-Identity-FEDERATION credential is `external_account`,
                        // which the pinned crate cannot deserialize — turn the bare serde text
                        // into something an operator can act on rather than letting the
                        // deployment silently run on whatever the metadata server offers
                        // (ITEM-5 / DEC-4).
                        // Bound the crate's own message too. Truncating only our `kind`
                        // string would have been theatre: the serde failure `{e}` reads
                        // "unknown variant `<the same untruncated value>`", so an
                        // adversarial credential file put its whole contents in the
                        // response body through the half nobody bounded.
                        let e = truncate_for_message(&e.to_string(), 400);
                        match seeded_adc.then(unsupported_gcp_adc).flatten() {
                            Some(hint) => AppError::internal_error(format!(
                                "workstore: GCS backend build failed: {e}. {hint}"
                            )),
                            None => AppError::internal_error(format!(
                                "workstore: GCS backend build failed: {e}"
                            )),
                        }
                    })?)
                }
            };
            Ok(Self {
                inner,
                multipart_threshold: cfg.multipart_threshold,
                part_size: cfg.part_size.max(5 * 1024 * 1024),
            })
        }

        /// The bucket object path for a bare hex digest: `blobs/<hex>`.
        fn key_path(hex: &str) -> OsPath {
            OsPath::from(format!("{BLOB_PREFIX}/{hex}"))
        }

        fn path_for_key(key: &ContentKey) -> OsPath {
            Self::key_path(key.hex())
        }

        /// Recover the `ContentKey` from an object path under `blobs/` (the last segment is
        /// the hex digest). `None` for anything not shaped like a blob object.
        fn key_from_path(location: &OsPath) -> Option<ContentKey> {
            let name = location.filename()?;
            if name.is_empty() {
                return None;
            }
            Some(ContentKey::from_hex(name))
        }

        /// Store `bytes` at `path`: a single `put` below the multipart threshold, else a
        /// `put_multipart` split into `part_size` chunks (DEC-4). Content-addressed, so an
        /// object already present is byte-identical — skip the re-upload (dedup).
        async fn write_blob(&self, hex: &str, bytes: &[u8]) -> Result<(), AppError> {
            let path = Self::key_path(hex);
            // Dedup / idempotency: identical bytes ⇒ identical key ⇒ one object. A present
            // object is skipped; a non-absence head error just falls through to the write.
            if matches!(self.inner.head(&path).await, Ok(_)) {
                return Ok(());
            }
            // A blob that fits in a single part NEVER takes the multipart path — this also floors
            // the threshold at 1, so a (mis)configured `multipart_threshold == 0` cannot send an
            // EMPTY blob down `put_multipart` (which would emit zero `put_part`s and fail
            // `complete()` with no parts). `part_size` is already clamped ≥ 5 MiB.
            if bytes.len() <= self.part_size || bytes.len() < self.multipart_threshold {
                self.inner
                    .put(&path, PutPayload::from(Bytes::copy_from_slice(bytes)))
                    .await
                    .map_err(|e| map_os_err(&path, e))?;
                return Ok(());
            }
            let mut upload = self
                .inner
                .put_multipart(&path)
                .await
                .map_err(|e| map_os_err(&path, e))?;
            for chunk in bytes.chunks(self.part_size) {
                if let Err(e) = upload
                    .put_part(PutPayload::from(Bytes::copy_from_slice(chunk)))
                    .await
                {
                    // Best-effort abort so a failed multipart never lingers as a stranded,
                    // billable upload; then surface the real failure (never swallowed). If the
                    // abort ITSELF fails, warn so a stranded (billable) upload is not invisible.
                    if let Err(abort_err) = upload.abort().await {
                        tracing::warn!(path = %path, error = %abort_err, "workstore: multipart abort failed after a put_part error — parts may be stranded (billable)");
                    }
                    return Err(AppError::internal_error(format!(
                        "workstore: multipart put_part failed for {path}: {e}"
                    )));
                }
            }
            if let Err(e) = upload.complete().await {
                // A failed CompleteMultipartUpload can leave stranded, billable parts —
                // abort (best-effort) before surfacing the error, symmetric with the
                // put_part path (F4). Warn if the abort itself fails (stranded, billable).
                if let Err(abort_err) = upload.abort().await {
                    tracing::warn!(path = %path, error = %abort_err, "workstore: multipart abort failed after a complete() error — parts may be stranded (billable)");
                }
                return Err(map_os_err(&path, e));
            }
            Ok(())
        }
    }

    #[async_trait]
    impl ObjectStore for S3Store {
        // store_root() stays `None` (trait default): no local root ⇒ the GC ownership check
        // is skipped, as designed for a remote store.

        async fn put(&self, bytes: &[u8]) -> Result<ContentKey, AppError> {
            let hex = sha256_hex(bytes);
            self.write_blob(&hex, bytes).await?;
            Ok(ContentKey::from_hex(&hex))
        }

        async fn put_prefix(
            &self,
            members: &[(String, Vec<u8>)],
        ) -> Result<MultiFilePut, AppError> {
            // Identical identity construction to local_fs (INV-5): hash + store each member
            // (multipart for large members), then the manifest blob; the merkle root over
            // the members IS the backend-independent content_hash.
            let mut refs: Vec<MemberRef> = Vec::with_capacity(members.len());
            for (path, bytes) in members {
                let key = self.put(bytes).await?;
                refs.push(MemberRef {
                    path: path.clone(),
                    blob: key,
                    len: bytes.len() as u64,
                });
            }
            let content_hash = merkle_root(&refs);
            let manifest_bytes = encode_manifest(&refs);
            let object_key = self.put(&manifest_bytes).await?;
            Ok(MultiFilePut {
                object_key,
                content_hash,
                members: refs,
            })
        }

        async fn get(&self, key: &ContentKey) -> Result<Vec<u8>, AppError> {
            let path = Self::path_for_key(key);
            let res = self
                .inner
                .get(&path)
                .await
                .map_err(|e| map_os_err(&path, e))?;
            let bytes = res.bytes().await.map_err(|e| map_os_err(&path, e))?;
            Ok(bytes.to_vec())
        }

        async fn get_range(
            &self,
            key: &ContentKey,
            offset: u64,
            length: u64,
        ) -> Result<Vec<u8>, AppError> {
            let path = Self::path_for_key(key);
            // Clamp to the object length (local_fs / S3 byte-range semantics): an offset past
            // the end yields empty; an over-long span clamps to end-of-object.
            let total = self
                .inner
                .head(&path)
                .await
                .map_err(|e| map_os_err(&path, e))?
                .size;
            // Empty result for a zero-length ask or an offset at/past the end — matches the
            // local_fs oracle and avoids handing the crate a zero-width/invalid range (F5).
            if length == 0 || offset >= total {
                return Ok(Vec::new());
            }
            let end = offset.saturating_add(length).min(total);
            let bytes = self
                .inner
                .get_range(&path, offset..end)
                .await
                .map_err(|e| map_os_err(&path, e))?;
            Ok(bytes.to_vec())
        }

        async fn get_stream(
            &self,
            key: &ContentKey,
            offset: u64,
            length: u64,
        ) -> Result<ByteStream, AppError> {
            let path = Self::path_for_key(key);
            // Existence is resolved EAGERLY (a `head` before the first byte), so a missing
            // blob is an `AppError` here — not a mid-stream failure — and the handler can
            // still answer a clean 404 (trait contract, ITEM-37).
            let total = self
                .inner
                .head(&path)
                .await
                .map_err(|e| map_os_err(&path, e))?
                .size;
            // Existence was resolved above (eager). A zero-length ask or an offset at/past the
            // end yields a short (empty) stream, mirroring get_range's clamp + the oracle (F5).
            if length == 0 || offset >= total {
                return Ok(Box::pin(futures_util::stream::empty()));
            }
            let end = offset.saturating_add(length).min(total);
            let opts = GetOptions {
                range: Some(GetRange::Bounded(offset..end)),
                ..Default::default()
            };
            let res = self
                .inner
                .get_opts(&path, opts)
                .await
                .map_err(|e| map_os_err(&path, e))?;
            // `into_stream` is the SIMPLER read (§4.1): the range GET already answers with a
            // byte stream, mapped straight through as the `ByteStream`. The item error type
            // is `io::Error` because a fault here is AFTER the status line is on the wire.
            let stream = res.into_stream().map(|r| r.map_err(std::io::Error::other));
            Ok(Box::pin(stream))
        }

        async fn stat(&self, key: &ContentKey) -> Result<ObjectStat, AppError> {
            let path = Self::path_for_key(key);
            let meta = self
                .inner
                .head(&path)
                .await
                .map_err(|e| map_os_err(&path, e))?;
            Ok(ObjectStat { len: meta.size })
        }

        async fn exists(&self, key: &ContentKey) -> Result<bool, AppError> {
            let path = Self::path_for_key(key);
            match self.inner.head(&path).await {
                Ok(_) => Ok(true),
                Err(object_store::Error::NotFound { .. }) => Ok(false),
                // A transport error is NOT an absence — propagate it (mirrors local_fs).
                Err(e) => Err(map_os_err(&path, e)),
            }
        }

        async fn delete(&self, key: &ContentKey) -> Result<(), AppError> {
            let path = Self::path_for_key(key);
            match self.inner.delete(&path).await {
                Ok(()) => Ok(()),
                // Idempotent: deleting an already-absent blob is success.
                Err(object_store::Error::NotFound { .. }) => Ok(()),
                Err(e) => Err(map_os_err(&path, e)),
            }
        }

        async fn resolve_member(
            &self,
            manifest_key: &ContentKey,
            member_path: &str,
        ) -> Result<ContentKey, AppError> {
            let manifest_bytes = self.get(manifest_key).await?;
            let members = decode_manifest(&manifest_bytes)?;
            members
                .get(member_path)
                .map(|s| ContentKey::parse(s))
                .ok_or_else(|| AppError::not_found("Artifact member"))
        }

        async fn gc(
            &self,
            keep: &HashSet<String>,
            min_age_secs: u64,
        ) -> Result<GcReport, AppError> {
            let mut report = GcReport::default();
            let prefix = OsPath::from(BLOB_PREFIX);
            let mut listing = self.inner.list(Some(&prefix));
            while let Some(item) = listing.next().await {
                let meta = item.map_err(|e| {
                    AppError::internal_error(format!("workstore: s3 gc list failed: {e}"))
                })?;
                let Some(key) = Self::key_from_path(&meta.location) else {
                    continue;
                };
                report.scanned += 1;
                if keep.contains(key.as_str()) {
                    continue;
                }
                // GRACE: never free an object younger than `min_age_secs` (an ingest write is
                // put BEFORE its catalog row commits). Clock skew (a future timestamp) fails
                // safe by keeping the object, exactly like local_fs's unreadable-mtime case.
                if min_age_secs > 0 {
                    let age = Utc::now().signed_duration_since(meta.last_modified);
                    if age.num_seconds() < min_age_secs as i64 {
                        continue;
                    }
                }
                match self.inner.delete(&meta.location).await {
                    Ok(()) => {
                        report.freed += 1;
                        report.freed_bytes += meta.size;
                    }
                    // A persistently undeletable orphan must not be silently invisible every
                    // cycle — log so an operator sees it (never over-freed: it stays counted only
                    // on a real delete).
                    Err(e) => {
                        tracing::warn!(location = %meta.location, error = %e, "workstore: s3 gc could not delete an orphan blob (will retry next sweep)");
                    }
                }
            }
            Ok(report)
        }

        /// Enumerate every stored blob key by listing the `blobs/` prefix — the SAME listing
        /// `gc` walks, collecting keys instead of reclaiming.
        async fn list_keys(&self) -> Result<Vec<ContentKey>, AppError> {
            let mut out = Vec::new();
            let prefix = OsPath::from(BLOB_PREFIX);
            let mut listing = self.inner.list(Some(&prefix));
            while let Some(item) = listing.next().await {
                let meta = item.map_err(|e| {
                    AppError::internal_error(format!("workstore: s3 list_keys failed: {e}"))
                })?;
                if let Some(key) = Self::key_from_path(&meta.location) {
                    out.push(key);
                }
            }
            Ok(out)
        }
    }

    /// Map an `object_store` error, PRESERVING the "absent" vs "could not read" distinction
    /// (a transport failure reported as an absence is what lets a GC sweep treat a live
    /// artifact as memberless — mirrors local_fs's `map_blob_io_err`).
    fn map_os_err(path: &OsPath, e: object_store::Error) -> AppError {
        match e {
            object_store::Error::NotFound { .. } => AppError::not_found("Blob"),
            other => {
                tracing::error!(
                    path = %path,
                    error = %other,
                    "workstore: cloud object-store op failed for a reason that is NOT absence"
                );
                AppError::internal_error(format!(
                    "workstore: cloud object-store op failed: {other}"
                ))
            }
        }
    }
    // ─────────────────────────────────────────────────────────────────────────────
    // AMBIENT-IDENTITY TESTS (#72) — TEST-1 … TEST-6, TEST-8, TEST-9
    //
    // These live HERE, in the lib-test binary, rather than under `tests/workstore/`
    // (DEC-6). They must mutate the PROCESS environment — that is the whole point: a
    // helper taking `role_arn: &str` as an argument would let the fixture pre-supply the
    // value under test and the test would prove nothing. But `scripts/cloud-sim-guard.sh`
    // FAILS on a present `AWS_ROLE_ARN` / `AWS_WEB_IDENTITY_TOKEN_FILE` /
    // `GOOGLE_APPLICATION_CREDENTIALS`, and `s3_contract_test` shells out to it — so
    // running these in the integration binary would risk reddening the whole T2 tier for
    // an unrelated reason. A separate process contains the blast radius.
    //
    // They take the CRATE-WIDE `process_env_guard()` from `sandbox/env_image.rs`, not a
    // private mutex. That file's own comment records why, from a defect this repo already
    // paid for: "Before this there were three disjoint mutexes over overlapping globals,
    // which is not isolation — it is a slower race." `setenv` racing any `getenv` is a
    // data race whatever the key, and other modules' tests set variables on other threads
    // of this same binary.
    //
    // A GATE RUNS THEM: `just saas-ambient-identity-test`, invoked by `just
    // check-saas-both` alongside the sibling `saas-upload-limits-test`. Without that they
    // would compile under `--features saas` and execute in no gate at all — `just
    // test-unit` is `cargo test --lib` with NO feature, so the module does not even exist
    // in that binary, and `check-saas-both`'s other saas leg only type-checks. That is the
    // shape the justfile's own comment names: "a ceiling nothing observes is not a
    // ceiling". (An earlier draft of this comment named a recipe `test-saas-run` that does
    // not exist — a claim of coverage that was itself uncovered.)
    //
    // WHAT THESE PROVE, AND WHAT THEY DO NOT. They prove, by RUNNING, that the ambient
    // environment reaches the builder and that the federated arm is the one SELECTED.
    // They do NOT prove a live STS/IRSA exchange: that needs an EKS cluster with a pod
    // identity association, this box has no cloud credentials by design, and the design
    // doc's §12a says the credential *resolution* leg runs only in-cloud (INV-4).
    // ─────────────────────────────────────────────────────────────────────────────
    #[cfg(test)]
    mod ambient_identity_tests {
        use super::*;
        use crate::modules::sandbox::env_image::process_env_guard;

        /// RAII environment override. Restores each variable's PREVIOUS state on drop —
        /// including "it was unset", which is the case that matters: leaving
        /// `AWS_ROLE_ARN` behind would trip `cloud-sim-guard.sh` for every later test.
        struct EnvScope {
            saved: Vec<(String, Option<String>)>,
        }

        impl EnvScope {
            fn new() -> Self {
                Self { saved: Vec::new() }
            }

            fn set(mut self, key: &str, value: &str) -> Self {
                self.saved.push((key.to_string(), std::env::var(key).ok()));
                std::env::set_var(key, value);
                self
            }

            fn unset(mut self, key: &str) -> Self {
                self.saved.push((key.to_string(), std::env::var(key).ok()));
                std::env::remove_var(key);
                self
            }
        }

        impl Drop for EnvScope {
            fn drop(&mut self) {
                // Reverse order, so a key overridden twice lands back on its original.
                for (key, previous) in self.saved.iter().rev() {
                    match previous {
                        Some(value) => std::env::set_var(key, value),
                        None => std::env::remove_var(key),
                    }
                }
            }
        }

        /// Every variable these tests touch, plus every variable `cloud-sim-guard.sh`
        /// trips on that they could plausibly set. Cleared, so an "absent ⇒ None" leg
        /// cannot be satisfied by a value inherited from the developer's shell.
        const TOUCHED_ENV: &[&str] = &[
            "AWS_ROLE_ARN",
            "AWS_WEB_IDENTITY_TOKEN_FILE",
            "AWS_ROLE_SESSION_NAME",
            "AWS_ENDPOINT_URL_STS",
            "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
            "AWS_CONTAINER_CREDENTIALS_FULL_URI",
            "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
            "AWS_SESSION_TOKEN",
            "AWS_ENDPOINT",
            "AWS_ENDPOINT_URL_S3",
            "AWS_ALLOW_HTTP",
            "AWS_SKIP_SIGNATURE",
            "AWS_METADATA_ENDPOINT",
            "AWS_S3_EXPRESS",
            "AWS_UNSIGNED_PAYLOAD",
            "SERVICE_ACCOUNT",
            "GOOGLE_SERVICE_ACCOUNT",
            "GOOGLE_SERVICE_ACCOUNT_PATH",
            "GOOGLE_SERVICE_ACCOUNT_KEY",
            "GOOGLE_APPLICATION_CREDENTIALS",
        ];

        fn scrubbed() -> EnvScope {
            let mut scope = EnvScope::new();
            for key in TOUCHED_ENV {
                scope = scope.unset(key);
            }
            scope
        }

        /// A representative, syntactically-plausible value per variable, so TEST-1 can
        /// drive itself from the allowlist TABLE rather than a hand-copied list. A row
        /// added to the allowlist with no entry here fails the test loudly — which is the
        /// point: coverage must not be something a future edit can quietly skip.
        fn sample_for(var: &str) -> &'static str {
            match var {
                "AWS_ROLE_ARN" => "arn:aws:iam::123456789012:role/cyto-workstore",
                "AWS_WEB_IDENTITY_TOKEN_FILE" => {
                    "/var/run/secrets/eks.amazonaws.com/serviceaccount/token"
                }
                "AWS_ROLE_SESSION_NAME" => "cyto-session",
                "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI" => "/v2/credentials/abc123",
                "AWS_CONTAINER_CREDENTIALS_FULL_URI" => "http://169.254.170.23/v1/credentials",
                "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE" => {
                    "/var/run/secrets/pods.eks.amazonaws.com/serviceaccount/eks-pod-identity-token"
                }
                "GOOGLE_APPLICATION_CREDENTIALS" => "/var/run/secrets/gcp/adc.json",
                other => panic!(
                    "the ambient-identity allowlist gained `{other}` with no sample value. \
                     Add one so TEST-1 covers it — an allowlist entry no test asserts is \
                     how a wrong env-var-to-config-key mapping ships unnoticed."
                ),
            }
        }

        fn conn(provider: CloudProvider, endpoint: Option<String>) -> S3ConnConfig {
            S3ConnConfig {
                provider,
                bucket: "cyto-ambient-identity-test".to_string(),
                region: "us-east-1".to_string(),
                endpoint,
                // No static credentials: this is the whole point — with a key pair present
                // the crate short-circuits to the static arm and the federated arms are
                // never consulted, so the defect would be invisible.
                access_key_id: None,
                secret_access_key: None,
                path_style: false,
                multipart_threshold: 16 * 1024 * 1024,
                part_size: 8 * 1024 * 1024,
            }
        }

        /// A uniquely-named scratch file under the system temp dir, removed on drop.
        /// (`tempfile` is not a dependency of this crate and TEST-8 asserts this change
        /// added none, so the few bytes of scaffolding are cheaper than the alternative.)
        struct ScratchFile {
            path: std::path::PathBuf,
        }

        impl ScratchFile {
            fn with_contents(tag: &str, contents: &str) -> Self {
                let nanos = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .expect("system clock is after the epoch")
                    .as_nanos();
                let path = std::env::temp_dir().join(format!("cyto-{tag}-{nanos}.json"));
                std::fs::write(&path, contents).expect("write scratch credential file");
                Self { path }
            }

            fn as_str(&self) -> &str {
                self.path.to_str().expect("scratch path is utf-8")
            }
        }

        impl Drop for ScratchFile {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.path);
            }
        }

        // ── TEST-1 [acceptance] [invariant: INV-1] — the environment REACHES the builder,
        // for EVERY allowlist entry.
        //
        // The reading claim ("we call the right constructor") and the running claim ("the
        // env actually reaches the builder") are different claims, and this asserts the
        // second. The helpers read `std::env` themselves, so nothing here pre-supplies the
        // value under test.
        //
        // It iterates the ALLOWLIST TABLES rather than a hand-copied list of four keys,
        // AND pins each pairing against an INDEPENDENT literal expectation below. Driving
        // both sides from the same table is not coverage: the implementation loops that
        // table applying `with_config(key, env(var))` and a test that loops the same table
        // asserting the same pairing stays green if two rows are SWAPPED, because both
        // sides read the identical corrupted mapping. `EXPECTED_AWS_PAIRS` is the second
        // opinion that makes a transposition fail.
        /// The var → config-key mapping, written out independently of the production
        /// table. If the two disagree, one of them is wrong and the test says so.
        const EXPECTED_AWS_PAIRS: &[(&str, AmazonS3ConfigKey)] = &[
            ("AWS_WEB_IDENTITY_TOKEN_FILE", AmazonS3ConfigKey::WebIdentityTokenFile),
            ("AWS_ROLE_ARN", AmazonS3ConfigKey::RoleArn),
            ("AWS_ROLE_SESSION_NAME", AmazonS3ConfigKey::RoleSessionName),
            (
                "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
                AmazonS3ConfigKey::ContainerCredentialsRelativeUri,
            ),
            (
                "AWS_CONTAINER_CREDENTIALS_FULL_URI",
                AmazonS3ConfigKey::ContainerCredentialsFullUri,
            ),
            (
                "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
                AmazonS3ConfigKey::ContainerAuthorizationTokenFile,
            ),
        ];

        #[test]
        fn test_1_every_ambient_identity_variable_reaches_its_builder() {
            let _lock = process_env_guard();

            // The anti-circularity check: the production table must agree, EXACTLY and in
            // both directions, with an expectation written independently of it. This is
            // what catches a transposed pair — the failure mode the table-driven loops
            // below are structurally blind to.
            let actual: Vec<(&str, AmazonS3ConfigKey)> = aws_identity_env().to_vec();
            assert_eq!(
                actual,
                EXPECTED_AWS_PAIRS.to_vec(),
                "the AWS identity allowlist does not match the independently-written \
                 expectation. Either a variable is mapped to the wrong config key — which \
                 no table-driven assertion can catch, because implementation and test \
                 would read the same wrong table — or a row was added/removed without \
                 updating EXPECTED_AWS_PAIRS."
            );
            assert_eq!(
                gcp_identity_env().to_vec(),
                vec![(
                    "GOOGLE_APPLICATION_CREDENTIALS",
                    GoogleConfigKey::ApplicationCredentials
                )],
                "the GCP identity allowlist is deliberately one entry (DEC-9); adding a \
                 GOOGLE_SERVICE_ACCOUNT* spelling reopens the gcs_base_url redirect"
            );

            // ── AWS, present ──────────────────────────────────────────────────────────
            {
                let mut scope = scrubbed();
                for (var, _) in aws_identity_env() {
                    scope = scope.set(var, sample_for(var));
                }
                let seeded = with_ambient_aws_identity(AmazonS3Builder::new());
                for (var, key) in aws_identity_env() {
                    assert_eq!(
                        seeded.get_config_value(key).as_deref(),
                        Some(sample_for(var)),
                        "{var} must reach the builder as {key:?} — an identity variable \
                         that does not arrive leaves its credential arm dead, and the \
                         chain falls through to the EC2 node role"
                    );
                }
            }

            // ── AWS, absent (the control) ─────────────────────────────────────────────
            // A constructor that hard-coded a value, or a fixture that supplied one, would
            // pass the block above and fail here.
            {
                let _scope = scrubbed();
                let bare = with_ambient_aws_identity(AmazonS3Builder::new());
                for (var, key) in aws_identity_env() {
                    assert_eq!(
                        bare.get_config_value(key),
                        None,
                        "{key:?} must be unset when {var} is absent"
                    );
                }
            }

            // ── GCP, present and absent ───────────────────────────────────────────────
            {
                let mut scope = scrubbed();
                for (var, _) in gcp_identity_env() {
                    scope = scope.set(var, sample_for(var));
                }
                let seeded = with_ambient_gcp_identity(GoogleCloudStorageBuilder::new());
                for (var, key) in gcp_identity_env() {
                    assert_eq!(
                        seeded.get_config_value(key).as_deref(),
                        Some(sample_for(var)),
                        "{var} must reach the builder as {key:?} — otherwise the ADC \
                         reader probes only $HOME/.config/gcloud (absent in a container) \
                         and the chain falls through to the GCE metadata server"
                    );
                }
            }
            {
                let _scope = scrubbed();
                let bare = with_ambient_gcp_identity(GoogleCloudStorageBuilder::new());
                for (var, key) in gcp_identity_env() {
                    assert_eq!(
                        bare.get_config_value(key),
                        None,
                        "{key:?} must be unset when {var} is absent"
                    );
                }
            }
        }

        // ── TEST-2 [acceptance] [invariant: INV-2] — the WEB-IDENTITY ARM IS SELECTED,
        // observed through the REAL `S3Store::from_conn` entrypoint.
        //
        // TEST-1 proves the helper works; this proves the helper is WIRED (FB-17) — a
        // seam nothing calls is not a fix. The discriminator is the crate's own error
        // text: `Failed to read token file '<path>'` is emitted at
        // `object_store-0.13.2 src/aws/credential.rs:662`, INSIDE `web_identity()` and
        // BEFORE its HTTP POST to STS. That line is reachable only from the
        // `if let (Some(token_path), Some(role_arn))` arm at `src/aws/builder.rs:1107`.
        // Seeing it is therefore a direct observation that both builder fields were
        // populated — i.e. that the environment reached the builder — with no network.
        // (The only nearby string is "Failed to read EKS token file" at `:794`, which is
        // not a superstring, so no unrelated arm can false-green this.)
        //
        // MUTATION CONTROL: revert `with_ambient_aws_identity(AmazonS3Builder::new())` to
        // `AmazonS3Builder::new()` and this must go RED, reporting the IMDS/metadata
        // failure instead. A test that survives the fix's removal is worth nothing.
        #[tokio::test]
        async fn test_2_from_conn_selects_the_web_identity_arm_not_imds() {
            let _lock = process_env_guard();

            let token_path = "/nonexistent/cyto-72/serviceaccount/token";
            let _scope = scrubbed()
                .set("AWS_ROLE_ARN", "arn:aws:iam::123456789012:role/cyto-workstore")
                .set("AWS_WEB_IDENTITY_TOKEN_FILE", token_path);

            let store = S3Store::from_conn(&conn(CloudProvider::S3, None))
                .expect("the S3 handle builds — `build()` issues no network I/O");

            // Force credential resolution. Bounded, because the IMDS fallthrough this
            // must NOT take would dial link-local 169.254.169.254 and could stall; a
            // timeout fails the assertion below just as a wrong error would.
            let outcome = tokio::time::timeout(
                std::time::Duration::from_secs(20),
                store.get(&ContentKey::from_hex(&"0".repeat(64))),
            )
            .await;

            let err = match outcome {
                Ok(Ok(_)) => panic!("no credential can exist for a bogus role — a read must fail"),
                Ok(Err(e)) => e.to_string(),
                Err(_elapsed) => panic!(
                    "credential resolution timed out: the web-identity arm fails LOCALLY on \
                     an unreadable token file, so a stall means a different (network) arm — \
                     almost certainly the IMDS fallthrough — was selected"
                ),
            };

            assert!(
                err.contains("Failed to read token file"),
                "the WEB-IDENTITY arm must be the one selected — that message comes from \
                 object_store's `web_identity()` and is reachable only when BOTH \
                 web_identity_token_file and role_arn were set on the builder. Without the \
                 ambient-identity seeding the chain falls through to the EC2 node role. \
                 Actual error: {err}"
            );
            assert!(
                err.contains(token_path),
                "the error must name the token file the ENVIRONMENT supplied, proving the \
                 value travelled from `std::env` into the builder. Actual error: {err}"
            );
            // Redundant on the green path (the two strings come from mutually exclusive
            // arms) but kept deliberately: on the RED path it is the assertion that NAMES
            // the defect, so the mutation run's output says "it went to IMDS" instead of
            // merely "the string was missing".
            assert!(
                !err.contains("169.254.169.254"),
                "the instance-metadata (node role) provider must NOT be reached — that is \
                 the defect #72 is about. Actual error: {err}"
            );
        }

        // ── TEST-3 — the allowlist EXCLUDES endpoint, signing and static-credential keys
        // (ITEM-2 / DEC-1).
        //
        // Asserts the TABLE, not just some values it produces, so an endpoint or signing
        // key added "just for this one deployment" later fails structurally.
        //
        // HONEST LIMIT, stated because an earlier version of this comment claimed
        // otherwise: a structural assertion over two static tables CAN be satisfied while
        // `from_conn` calls something else entirely. Swapping the call site to
        // `AmazonS3Builder::from_env()` leaves this table untouched and every assertion
        // here green. What actually pins the call site is TEST-2 (which observes the arm
        // `from_conn` selected) plus the `from_env`-detecting leg at the end of this test,
        // which drives `from_conn` with a hostile `AWS_ENDPOINT` and asserts the store
        // still talks to the configured endpoint. Neither the table nor the helper
        // assertions alone would catch it.
        //
        // `AWS_ENDPOINT_URL_STS` is in the denylist for a reason worth stating: an
        // identity allowlist that admits an arbitrary endpoint is WORSE than an endpoint
        // allowlist, because what travels to that endpoint is the pod's projected JWT.
        #[test]
        fn test_3_the_allowlist_admits_no_endpoint_signing_or_static_credential_key() {
            let _lock = process_env_guard();

            for forbidden in AWS_FORBIDDEN_AMBIENT_KEYS {
                assert!(
                    !aws_identity_env().iter().any(|(_, key)| key == forbidden),
                    "{forbidden:?} must NEVER be reachable from the ambient environment. \
                     The data endpoint and metadata endpoint would redirect the store; \
                     the STS and container-credential endpoints would redirect the \
                     IDENTITY (they receive the token); the signing switches would let the \
                     environment turn request signing off; and the static key pair plus \
                     its session token belong to S3ConnConfig, never to ambient env."
                );
            }

            // POSITIVE CONTROL: the disjointness above is trivially satisfiable by an
            // EMPTY allowlist, which would also "fix" #72 by doing nothing. Assert the
            // identity keys that must be present really are.
            for required in [
                AmazonS3ConfigKey::RoleArn,
                AmazonS3ConfigKey::WebIdentityTokenFile,
                AmazonS3ConfigKey::ContainerCredentialsRelativeUri,
                AmazonS3ConfigKey::ContainerCredentialsFullUri,
            ] {
                assert!(
                    aws_identity_env().iter().any(|(_, key)| *key == required),
                    "{required:?} must be admitted — otherwise the allowlist passes the \
                     exclusion check by admitting nothing at all"
                );
            }

            // And the behavioural half: hostile values in the environment do not arrive.
            let _scope = scrubbed()
                .set("AWS_ENDPOINT", "https://s3.attacker.example")
                .set("AWS_ENDPOINT_URL_S3", "https://s3.attacker.example")
                .set("AWS_ENDPOINT_URL_STS", "https://sts.attacker.example")
                .set("AWS_SESSION_TOKEN", "ambient-session-token")
                .set("AWS_SKIP_SIGNATURE", "true")
                .set("AWS_METADATA_ENDPOINT", "http://169.254.169.254")
                .set("AWS_S3_EXPRESS", "true")
                .set("AWS_ROLE_ARN", "arn:aws:iam::123456789012:role/cyto-workstore")
                .set(
                    "AWS_WEB_IDENTITY_TOKEN_FILE",
                    "/var/run/secrets/eks.amazonaws.com/serviceaccount/token",
                );
            let seeded = with_ambient_aws_identity(AmazonS3Builder::new());

            // `Option<String>`-backed keys: the hostile value must not arrive at all.
            for key in [
                AmazonS3ConfigKey::Endpoint,
                AmazonS3ConfigKey::S3Endpoint,
                AmazonS3ConfigKey::StsEndpoint,
                AmazonS3ConfigKey::MetadataEndpoint,
                AmazonS3ConfigKey::Token,
            ] {
                assert_eq!(
                    seeded.get_config_value(&key),
                    None,
                    "{key:?} must NOT be reachable from the ambient environment"
                );
            }

            // `ConfigValue<bool>`-backed keys: `get_config_value` renders the DEFAULT
            // rather than `None` (`0.13.2 src/aws/builder.rs:724`/`:744` —
            // `Some(self.s3_express.to_string())`), so "is it None?" is the wrong question
            // and would fail against a correct implementation.
            for key in [
                AmazonS3ConfigKey::SkipSignature,
                AmazonS3ConfigKey::S3Express,
            ] {
                assert_eq!(
                    seeded.get_config_value(&key).as_deref(),
                    Some("false"),
                    "{key:?} must remain at the crate's safe default, not the `true` the \
                     environment asked for"
                );
            }
        }

        // ── TEST-3d — `from_conn` itself does not honour an ambient endpoint.
        //
        // This is the leg that actually pins the CALL SITE. TEST-3's table assertions are
        // about two static tables and would survive `from_conn` switching to
        // `AmazonS3Builder::from_env()`; this one would not, because `from_env()` reads
        // `AWS_ENDPOINT` and the emulator endpoint the app configured would be replaced.
        //
        // The observable is the emulator arm: with `cfg.endpoint = Some(loopback)` and a
        // hostile `AWS_ENDPOINT` in the environment, a `from_env()`-built store would
        // resolve the hostile host, while the correct build keeps the app's own. We look
        // at it through a REAL request, so the assertion is about where bytes would go.
        #[tokio::test]
        async fn test_3d_from_conn_ignores_an_ambient_endpoint() {
            let _lock = process_env_guard();
            let _scope = scrubbed()
                .set("AWS_ENDPOINT", "http://127.0.0.99:9/hostile")
                .set("AWS_ENDPOINT_URL_S3", "http://127.0.0.99:9/hostile");

            // Point the app at a loopback port with nothing listening: the connection
            // refusal names the host that was actually used.
            //
            // STATIC CREDS are required for this observable to exist. Without them the
            // credential chain resolves FIRST and falls through to IMDS, so the request
            // never reaches any endpoint and the error names 169.254.169.254 regardless of
            // which endpoint was configured — the test would then be measuring the
            // credential chain, not the endpoint. Path-style keeps the bucket out of the
            // host so the host in the error is the endpoint's.
            let mut cfg = conn(CloudProvider::S3, Some("http://127.0.0.1:9".to_string()));
            cfg.access_key_id = Some("emulator-key".to_string());
            cfg.secret_access_key = Some("emulator-secret".to_string());
            cfg.path_style = true;
            let store = S3Store::from_conn(&cfg).expect("the S3 handle builds");

            let err = tokio::time::timeout(
                std::time::Duration::from_secs(20),
                store.get(&ContentKey::from_hex(&"0".repeat(64))),
            )
            .await
            .expect("a loopback connection refusal is immediate")
            .expect_err("nothing is listening on the configured endpoint")
            .to_string();

            assert!(
                !err.contains("127.0.0.99"),
                "`from_conn` honoured AWS_ENDPOINT from the ambient environment — that is \
                 what a switch to `AmazonS3Builder::from_env()` would do, and it defeats \
                 `config.rs::endpoint_seam`'s guarantee that a release binary cannot be \
                 redirected. Actual error: {err}"
            );
            assert!(
                err.contains("127.0.0.1:9"),
                "the request must go to the endpoint the APP configured: {err}"
            );
        }

        // ── TEST-3b — the fail-closed half (ITEM-2 / the #69/#70 convention).
        //
        // #72's thesis is that a half-configured federated identity did not FAIL — it fell
        // through to the node role and worked. Making the arm reachable is only half a
        // fix; refusing the half-configured state is the other half, and without it a
        // typo'd AWS_ROLE_ARN still ships a pod running on node-wide credentials.
        #[test]
        fn test_3b_half_configured_or_off_box_identity_is_refused_not_ignored() {
            let _lock = process_env_guard();

            // Only the role ARN → refuse, naming the missing half.
            {
                let _scope = scrubbed()
                    .set("AWS_ROLE_ARN", "arn:aws:iam::123456789012:role/cyto-workstore");
                let err = S3Store::from_conn(&conn(CloudProvider::S3, None))
                    .expect_err("a half-configured IRSA pair must refuse, not fall through")
                    .to_string();
                assert!(
                    err.contains("AWS_WEB_IDENTITY_TOKEN_FILE") && err.contains("NODE role"),
                    "the refusal must name the missing variable and say what would \
                     otherwise be used: {err}"
                );
            }

            // Only the token file → refuse, naming the other missing half.
            {
                let _scope = scrubbed().set(
                    "AWS_WEB_IDENTITY_TOKEN_FILE",
                    "/var/run/secrets/eks.amazonaws.com/serviceaccount/token",
                );
                let err = S3Store::from_conn(&conn(CloudProvider::S3, None))
                    .expect_err("a half-configured IRSA pair must refuse, not fall through")
                    .to_string();
                assert!(
                    err.contains("AWS_ROLE_ARN"),
                    "the refusal must name the missing variable: {err}"
                );
            }

            // An off-box container-credentials endpoint → refuse. That URL receives the
            // contents of the authorization token file over plaintext HTTP and returns
            // credentials this process would adopt, so an arbitrary host is both an
            // exfiltration and an injection path.
            {
                // BOTH halves set, so the both-or-nothing check passes and the HOST check
                // is the one under test. (Setting only the URI made the pair refusal fire
                // first and this assertion failed on the wrong message — a reminder that
                // an ordered chain of refusals needs each leg to reach the one it names.)
                let _scope = scrubbed()
                    .set("AWS_CONTAINER_CREDENTIALS_FULL_URI", "http://attacker.example/creds")
                    .set(
                        "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
                        "/var/run/secrets/pods.eks.amazonaws.com/serviceaccount/eks-pod-identity-token",
                    );
                let err = S3Store::from_conn(&conn(CloudProvider::S3, None))
                    .expect_err("an off-box credential endpoint must be refused")
                    .to_string();
                assert!(
                    err.contains("link-local") && err.contains("attacker.example"),
                    "the refusal must name the offending host and the rule: {err}"
                );
            }

            // CONTROL: the real EKS Pod Identity endpoint is link-local and must BUILD.
            // Without this the refusal above could be satisfied by refusing everything.
            {
                let _scope = scrubbed()
                    .set(
                        "AWS_CONTAINER_CREDENTIALS_FULL_URI",
                        "http://169.254.170.23/v1/credentials",
                    )
                    .set(
                        "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
                        "/var/run/secrets/pods.eks.amazonaws.com/serviceaccount/eks-pod-identity-token",
                    );
                assert!(
                    S3Store::from_conn(&conn(CloudProvider::S3, None)).is_ok(),
                    "real EKS Pod Identity uses the link-local agent and must still build"
                );
            }

            // A half-configured EKS POD IDENTITY pair → refuse. The crate's arm is
            // `if let (Some(full_uri), Some(token_file))`, exactly like the web-identity
            // arm, so one alone falls through to IMDS in the identical way. An earlier
            // round covered only the IRSA pair and read as if it covered both.
            {
                let _scope = scrubbed().set(
                    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
                    "http://169.254.170.23/v1/credentials",
                );
                let err = S3Store::from_conn(&conn(CloudProvider::S3, None))
                    .expect_err("a half-configured Pod Identity pair must refuse")
                    .to_string();
                assert!(
                    err.contains("AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE"),
                    "the refusal must name the missing half: {err}"
                );
            }
            {
                let _scope = scrubbed().set(
                    "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
                    "/var/run/secrets/pods.eks.amazonaws.com/serviceaccount/eks-pod-identity-token",
                );
                let err = S3Store::from_conn(&conn(CloudProvider::S3, None))
                    .expect_err("a half-configured Pod Identity pair must refuse")
                    .to_string();
                assert!(
                    err.contains("AWS_CONTAINER_CREDENTIALS_FULL_URI"),
                    "the refusal must name the missing half: {err}"
                );
            }

            // An ECS relative URI that MOVES THE HOST → refuse. The crate interpolates it
            // as `format!("http://169.254.170.2{uri}")` with no path join, so `@evil…`
            // and `.evil…` relocate the credential endpoint. An earlier round asserted in
            // a comment that this variable was "safe unconditionally" because the crate
            // pinned the host. It does not.
            for hostile in ["@evil.example/creds", ".evil.example/creds"] {
                let _scope = scrubbed().set("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", hostile);
                let err = S3Store::from_conn(&conn(CloudProvider::S3, None))
                    .expect_err("an ECS relative URI that moves the host must be refused")
                    .to_string();
                assert!(
                    err.contains("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"),
                    "the refusal must name the variable for {hostile}: {err}"
                );
            }

            // CONTROL: a genuine ECS relative URI must still build.
            {
                let _scope =
                    scrubbed().set("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "/v2/credentials/abc");
                assert!(
                    S3Store::from_conn(&conn(CloudProvider::S3, None)).is_ok(),
                    "a real ECS task-role relative URI must still build"
                );
            }

            // A region that moves the STS host → refuse. This exposure is NEW: before the
            // web-identity arm became reachable nothing interpolated the region into a
            // credential endpoint, so closing it belongs to this change.
            {
                let _scope = scrubbed();
                let mut bad_region = conn(CloudProvider::S3, None);
                bad_region.region = "attacker.example/".to_string();
                let err = S3Store::from_conn(&bad_region)
                    .expect_err("a region that moves the endpoint host must be refused")
                    .to_string();
                assert!(
                    err.contains("AWS_REGION"),
                    "the refusal must name the region: {err}"
                );
            }

            // CONTROL: a fully-unset environment must build (the IMDS fallthrough is a
            // legitimate deployment, just not a pod-scoped one).
            {
                let _scope = scrubbed();
                assert!(
                    S3Store::from_conn(&conn(CloudProvider::S3, None)).is_ok(),
                    "an environment with no federated identity at all is not an error"
                );
            }
        }

        // ── TEST-3c — the host validator actually distinguishes (supports TEST-3b).
        //
        // `cloud-sim-guard.sh` carries a comment recording that a naive `127.*` glob plus
        // no userinfo strip let a REAL host masquerade as loopback and "defeated the
        // guard's whole purpose". The same two evasions are asserted here, because a host
        // check that accepts `http://169.254.170.2@evil.example` is not a host check.
        #[test]
        fn test_3c_the_credential_host_check_rejects_the_known_evasions() {
            for accepted in [
                "http://169.254.170.23/v1/credentials",
                "http://169.254.169.254/latest",
                "http://127.0.0.1:4566/x",
                "http://localhost:8080/creds",
                "http://[::1]:8080/creds",
            ] {
                assert!(
                    is_local_credential_host(accepted),
                    "{accepted} is genuinely link-local/loopback and must be accepted"
                );
            }
            for rejected in [
                // userinfo — the link-local text is a USERNAME
                "http://169.254.170.2@evil.example/creds",
                // label-suffix
                "http://127.0.0.1.evil.example/creds",
                "http://169.254.170.2.evil.example/creds",
                // the authority ends at `?` and `#` too, not only `/` — these read as
                // loopback to a naive parser and resolve to `evil.example` in the client
                "http://evil.example?@127.0.0.1",
                "http://evil.example#@169.254.170.23",
                "http://evil.example?x=169.254.170.23",
                // WHATWG reads a leading-zero part as OCTAL, so `0127.0.0.1` is 87.0.0.1 —
                // a PUBLIC address — while Rust's `u8::from_str` returns 127.
                //
                // The first two are ALSO caught by the 1-3 digit length cap, which made
                // the leading-zero rule itself unobserved: a mutation deleting that rule
                // left this whole test green. `127.0.0.010` is the case that observes it —
                // three digits, so the length cap does not fire, and `"010".parse::<u8>()`
                // gives 10, which our validator would call loopback. Nobody has shown an
                // input where the two parsers disagree AND the verdict flips to accept
                // (a leading-zero first octet can never read as 127 or 169 in decimal), so
                // this is defence in depth rather than a live hole — but a guard that
                // no test can distinguish from its own absence is one nobody can maintain,
                // which is the whole reason it is pinned here. We refuse an AMBIGUOUS form
                // rather than bet on which parser the client uses.
                "http://0127.0.0.1/creds",
                "http://00127.0.0.1/creds",
                "http://127.0.0.010/creds",
                "http://169.254.0.010/creds",
                // `u8::from_str` also accepts a leading `+`
                "http://+127.0.0.1/creds",
                // plain wrong
                "https://attacker.example/creds",
                "http://169.254.170/creds",
                "http://16.925.417.023/creds",
                "http://evil.example/169.254.170.23",
                // no scheme ⇒ not a URL the client can resolve; fail closed
                "169.254.170.23/creds",
                "localhost:8080",
                // non-http schemes
                "file:///etc/passwd",
                "ftp://169.254.170.23/creds",
            ] {
                assert!(
                    !is_local_credential_host(rejected),
                    "{rejected} is NOT link-local — accepting it would send the pod's \
                     credential token off-box"
                );
            }
        }

        // ── TEST-4 — the GCS emulator arm resolves NO ambient credential (ITEM-3 / DEC-2).
        //
        // REWRITTEN after an audit showed the previous version was vacuous. It asserted
        // that the emulator arm builds with a structurally-invalid ADC document present,
        // and concluded "the carve-out held". But the crate reads ADC only
        // `if service_account_credentials.is_none() && self.credentials.is_none()`, and
        // the emulator arm always sets `self.credentials` to the anonymous provider — so
        // the file is never opened whether the carve-out exists or not. Deleting the
        // feature left the test green. What is actually load-bearing on that arm is the
        // anonymous provider, and what the carve-out still governs is the ADC HINT, so
        // those are what this asserts.
        #[test]
        fn test_4_the_gcs_emulator_arm_resolves_no_ambient_credential() {
            let _lock = process_env_guard();

            // A document the crate CANNOT deserialize (`private_key`, `private_key_id` and
            // `client_email` have no serde defaults).
            let bad = ScratchFile::with_contents("gcs-emulator-adc", r#"{"type":"service_account"}"#);
            let _scope = scrubbed().set("GOOGLE_APPLICATION_CREDENTIALS", bad.as_str());

            let emulated = S3Store::from_conn(&conn(
                CloudProvider::Gcs,
                Some("http://127.0.0.1:4588".to_string()),
            ));
            assert!(
                emulated.is_ok(),
                "the floci-gcp emulator arm must build with GCP credential variables \
                 present — it goes anonymous by design: {:?}",
                emulated.err().map(|e| e.to_string())
            );

            // CONTROL: the SAME document on the real-GCS arm (no endpoint) IS read, and
            // fails. This is what proves the document is genuinely unusable, so the
            // emulator's success above is the anonymous provider working rather than the
            // fixture being harmless.
            let real = S3Store::from_conn(&conn(CloudProvider::Gcs, None));
            let real_err = real
                .expect_err(
                    "the real-GCS arm must consult GOOGLE_APPLICATION_CREDENTIALS — if this \
                     builds, the emulator assertion above proves nothing",
                )
                .to_string();
            assert!(
                real_err.contains("GCS backend build failed"),
                "expected the crate's own credential failure: {real_err}"
            );

            // And the part the carve-out DOES still govern: the ADC hint is arm-specific.
            // Make the EMULATOR arm fail for an unrelated reason while an unsupported ADC
            // sits in the environment, and the failure must not be blamed on the
            // credential that arm never read.
            let wif = ScratchFile::with_contents("wif-emulator", r#"{"type":"external_account"}"#);
            let _wif_scope = scrubbed().set("GOOGLE_APPLICATION_CREDENTIALS", wif.as_str());
            let mut emulator_bad_url = conn(CloudProvider::Gcs, Some("not a url".to_string()));
            emulator_bad_url.bucket = "cyto-ambient-identity-test".to_string();
            if let Err(e) = S3Store::from_conn(&emulator_bad_url) {
                assert!(
                    !e.to_string().contains("external_account"),
                    "a failure on the EMULATOR arm must not be explained by a credential \
                     that arm never read: {e}"
                );
            }
        }

        // ── TEST-5 — GCP WIF (`external_account`) fails LEGIBLY (ITEM-5 / DEC-4).
        //
        // Driven through the real `from_conn`, so this also re-proves ITEM-3: the refusal
        // is only possible because GOOGLE_APPLICATION_CREDENTIALS now reaches the builder
        // and the crate actually reads the file. Before #72 the file was ignored and the
        // deployment came up working on whatever the metadata server offered — the node's
        // service account on a cluster without Workload Identity.
        #[test]
        fn test_5_gcp_workload_identity_federation_is_refused_not_ignored() {
            let _lock = process_env_guard();

            let wif = ScratchFile::with_contents(
                "wif-adc",
                r#"{"type":"external_account","audience":"//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/v"}"#,
            );
            let scope = scrubbed().set("GOOGLE_APPLICATION_CREDENTIALS", wif.as_str());

            let err = S3Store::from_conn(&conn(CloudProvider::Gcs, None))
                .expect_err(
                    "an external_account credential cannot be consumed by object_store \
                     0.13.2 — building must REFUSE rather than fall through to whatever \
                     identity the metadata server offers",
                )
                .to_string();

            // The CRATE's own refusal must be present. Without this the test would pass on
            // any unrelated GCS build failure that happened to occur while a WIF file was
            // in the environment — our hint alone is a pure function of the fixture, so
            // asserting only on it is a tautology.
            // The CRATE's own refusal must be what failed. `unknown variant` is emitted
            // by serde inside `read_credentials_file`; it is the only part of this message
            // our own code did not author.
            //
            // An earlier version added `|| err.contains("GCS backend build failed")` as a
            // third disjunct — which is OUR wrapper text, emitted on every GCS build
            // failure, so the disjunction was true unconditionally. The assertion added to
            // prevent a false-green WAS the false-green. Removed.
            assert!(
                err.contains("unknown variant"),
                "the crate's own deserialization refusal must be what failed — without \
                 this the test passes on any GCS failure that happens while a WIF file is \
                 in the environment, since every other assertion here matches text our own \
                 hint produces from the fixture: {err}"
            );
            assert!(
                err.contains("external_account"),
                "the refusal must name the unsupported credential type: {err}"
            );
            assert!(
                err.contains("GOOGLE_APPLICATION_CREDENTIALS"),
                "the refusal must name the variable the operator has to change: {err}"
            );
            assert!(
                err.contains("GKE Workload Identity") && err.contains("service-account key"),
                "the refusal must name the alternatives that DO work: {err}"
            );
            drop(scope);

            // CONTROL 1: the hint is not unconditional. A `service_account` document is a
            // type the crate DOES support, so it must not trip the WIF explanation.
            let sa = ScratchFile::with_contents("sa-adc", r#"{"type":"service_account"}"#);
            let _sa_scope = scrubbed().set("GOOGLE_APPLICATION_CREDENTIALS", sa.as_str());
            assert_eq!(
                unsupported_gcp_adc(),
                None,
                "a supported credential type must not produce the WIF refusal"
            );
            drop(_sa_scope);

            // CONTROL 2: the hint must not fire when the ADC file is FINE and the build
            // fails for another reason. The previous version used an empty bucket, which
            // `from_conn` rejects at its very first line — before the provider match, the
            // GCS builder, `build()` and the error-mapping closure ever run. It asserted
            // that a code path which cannot add the hint did not add the hint. This
            // version keeps a SUPPORTED credential type in place and reaches the real
            // `build()` error path.
            let sa2 = ScratchFile::with_contents("sa-adc-2", r#"{"type":"service_account"}"#);
            let _scope2 = scrubbed().set("GOOGLE_APPLICATION_CREDENTIALS", sa2.as_str());
            let unrelated = S3Store::from_conn(&conn(CloudProvider::Gcs, None))
                .expect_err("an unusable service-account document still fails the build")
                .to_string();
            assert!(
                unrelated.contains("GCS backend build failed"),
                "expected the real build error path: {unrelated}"
            );
            assert!(
                !unrelated.contains("external_account"),
                "a failure with a SUPPORTED credential type must not be explained as a WIF \
                 problem — an explanation that is confidently wrong is worse than none: \
                 {unrelated}"
            );
        }

        // ── TEST-6 — the false comment cannot come back (ITEM-4 / ITEM-6).
        //
        // A comment cannot be behaviour-tested, but it can be regression-guarded, and this
        // one earned a guard: it stated that absent static creds the code fell back to
        // "the crate's ambient identity chain (IRSA / web-identity / IMDS)", which was
        // false in a way that would stop the next reader ever looking. It is also the
        // silent-merge shape this project has hit repeatedly — a re-flow of that comment
        // on another branch merges without conflict and resurrects the claim.
        //
        // BOTH needles are split with `concat!`. `SELF_SOURCE` is this very file, so a
        // needle spelled as one literal is part of its own haystack: for `!contains` that
        // forces a permanent RED (which is how the first one was caught, on its first
        // run), and for `contains` it forces a permanent GREEN — the assertion passes even
        // if the thing it guards is deleted. The second form is the dangerous one, because
        // nothing ever tells you.
        #[test]
        fn test_6_the_retired_false_credential_comment_stays_retired() {
            const SELF_SOURCE: &str = include_str!("s3.rs");

            let retired = concat!("absent ⇒ the crate's ", "ambient identity chain");
            assert!(
                !SELF_SOURCE.contains(retired),
                "the retired comment claimed the ambient identity chain was reached when \
                 static creds were absent. It was not: the builder read no environment, so \
                 the chain fell through to the EC2 node role. Do not reintroduce it."
            );

            let matrix = concat!("AMBIENT-IDENTITY ", "REACHABILITY MATRIX");
            assert!(
                SELF_SOURCE.contains(matrix),
                "the module doc must carry the matrix saying which ambient-identity paths \
                 are reachable and which are not — that is what stops the next reader \
                 concluding GCP WIF already works"
            );
        }

        // ── TEST-8 [acceptance] [invariant: INV-3] — NO cloud SDK was added.
        //
        // `object_store` already contained the whole mechanism; the app simply never
        // invoked it. Reaching ambient identity must therefore cost zero dependencies —
        // the standing constraint, and §11's "no cloud SDK call outside `ObjectStore`"
        // lock-in rule. The structural half (marker types confined to this file) is the
        // pre-existing `the_cloud_sdk_is_confined_to_the_s3_seam` guard in `mod.rs`.
        //
        // This guard would also pass on pre-#72 `main`. That is correct for a
        // "we did not add X" invariant and is not a defect: its job is to fail on a FUTURE
        // edit that reaches for an SDK, which is exactly the temptation this issue creates.
        #[test]
        fn test_8_no_cloud_sdk_dependency_was_added() {
            const DENIED: &[&str] = &[
                "aws-sdk-",
                "aws-config",
                "aws-smithy",
                "google-cloud-",
                "gcp_auth",
                "opendal",
                "azure_",
            ];

            /// The matcher under test, factored out so the negative control can exercise
            /// the REAL one rather than re-implementing it (a control that re-implements
            /// the matcher proves only that the reimplementation works).
            fn offenders(manifest: &str, lock: &str) -> Vec<String> {
                let mut hits = Vec::new();
                for needle in DENIED {
                    if manifest.contains(needle) {
                        hits.push(format!("Cargo.toml: {needle}"));
                    }
                    if lock.contains(&format!("name = \"{needle}")) {
                        hits.push(format!("Cargo.lock: {needle}"));
                    }
                }
                hits
            }

            let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
            let manifest = std::fs::read_to_string(manifest_dir.join("Cargo.toml"))
                .expect("read the server manifest");
            let lock = std::fs::read_to_string(manifest_dir.join("../../Cargo.lock"))
                .expect("read the workspace lockfile");

            assert!(
                offenders(&manifest, &lock).is_empty(),
                "a cloud SDK entered the dependency graph — ambient identity is reached \
                 through object_store's own credential chain, not by adding an SDK: {:?}",
                offenders(&manifest, &lock)
            );

            // NEGATIVE CONTROL: a denylist whose matcher never fires reports PASS forever.
            // Run the REAL matcher over a synthetic manifest and lockfile that DO contain a
            // denied crate, so this proves the file-scanning path fires — not merely that
            // `str::contains` works.
            let planted_manifest = "[dependencies]\naws-config = \"1\"\n";
            let planted_lock = "[[package]]\nname = \"aws-sdk-s3\"\nversion = \"1.0\"\n";
            assert_eq!(
                offenders(planted_manifest, planted_lock).len(),
                2,
                "the denylist matcher does not fire against a planted dependency — every \
                 assertion above is vacuous"
            );
            // And it must not fire on a clean synthetic pair, or it would be a matcher
            // that reports an offender for everything.
            assert!(
                offenders("[dependencies]\nserde = \"1\"\n", "name = \"serde\"").is_empty(),
                "the matcher fires on a clean manifest — it would report PASS-as-FAIL"
            );
        }

        // ── TEST-9 [acceptance] [invariant: INV-4] — this suite stays credential-free,
        // and the env restore actually restores.
        //
        // Two claims in one run. First, INV-4's premise is verified rather than assumed:
        // the ambient-identity work was proven on a box with no real cloud credential.
        // Second — and this is the part the earlier version got wrong — that `EnvScope`'s
        // restore runs. It used to lean on TEST-9 happening to execute AFTER the other
        // tests, which libtest does not guarantee: tests run on a thread pool and a
        // `Mutex` is not FIFO-fair, so a TEST-9 scheduled first verified nothing and
        // passed unconditionally. It now performs its OWN set-and-drop of the variables
        // the guard trips on, inside the test, so the check is order-independent by
        // construction.
        #[test]
        fn test_9_the_suite_leaves_no_cloud_credential_behind() {
            let _lock = process_env_guard();

            let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../scripts/cloud-sim-guard.sh");
            let guard_passes = || {
                std::process::Command::new("bash")
                    .arg(&script)
                    .output()
                    .expect("run cloud-sim-guard.sh")
            };

            // Baseline: the box itself is credential-free (INV-4's premise).
            let before = guard_passes();
            assert!(
                before.status.success(),
                "cloud-sim-guard.sh must pass BEFORE this test touches anything — a real \
                 cloud credential is present, so INV-4's credential-free premise is false. \
                 stdout: {} stderr: {}",
                String::from_utf8_lossy(&before.stdout),
                String::from_utf8_lossy(&before.stderr),
            );

            // Now do what the other tests do, and prove the guard NOTICES it. Without this
            // leg the assertion below could pass against an EnvScope that restored nothing
            // AND a guard that checked nothing.
            {
                let _scope = scrubbed()
                    .set("AWS_ROLE_ARN", "arn:aws:iam::123456789012:role/cyto-workstore")
                    .set(
                        "AWS_WEB_IDENTITY_TOKEN_FILE",
                        "/var/run/secrets/eks.amazonaws.com/serviceaccount/token",
                    );
                let during = guard_passes();
                assert!(
                    !during.status.success(),
                    "cloud-sim-guard.sh must FAIL while AWS_ROLE_ARN / \
                     AWS_WEB_IDENTITY_TOKEN_FILE are set — if it does not, it is not \
                     watching the variables these tests set and the restore check below is \
                     vacuous"
                );
            }

            // And after the scope drops, it must be green again — the restore ran.
            let after = guard_passes();
            assert!(
                after.status.success(),
                "cloud-sim-guard.sh must pass again once EnvScope has dropped. A leaked \
                 AWS_ROLE_ARN would redden the whole s3_contract_test tier for a reason \
                 that has nothing to do with the contract. stdout: {} stderr: {}",
                String::from_utf8_lossy(&after.stdout),
                String::from_utf8_lossy(&after.stderr),
            );
        }
    }
}
#[cfg(feature = "saas")]
pub use real::S3Store;
