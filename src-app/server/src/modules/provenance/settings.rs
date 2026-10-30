//! Provenance settings singleton (ITEM-25 / DEC-5). Mirrors
//! `sandbox/settings.rs` verbatim: a `query_as!` singleton repo + `validate()`
//! (422 `PROVENANCE_SETTING_OUT_OF_RANGE`) + `merge()` + `settings_cache.rs`.
//! SQLite driver (sqlite-store DEC-1): the PG `NOW()` write clock is the
//! canonical `strftime('%Y-%m-%dT%H:%M:%fZ','now')` RFC3339-UTC form (DEC-8's
//! map — lexicographic == chronological) and `id = TRUE` stays verbatim
//! (the ITEM-19/20 precedent: recognized by the sqlite macro, checked at
//! runtime).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use ziee_core::AppError;

/// The singleton provenance settings row (matches migration
/// `202608030005_provenance_baseline.sql`).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, sqlx::FromRow)]
pub struct ProvenanceSettings {
    /// Export bundle size cap (over-cap objects become a `fetch.txt` hole).
    pub export_bundle_max_bytes: i64,
    /// Max bytes of EMITTED capture source stored per recorded selection
    /// (`provenance_code_blobs.source`). An over-cap recipe is refused with a 422
    /// and persists NOTHING — the bounded-growth guard on the interaction capture
    /// path (a 150k-element `idList` fits in the 2 MB body limit but emits
    /// megabytes, once per distinct recipe).
    pub capture_code_max_bytes: i64,
    /// Bundle/certificate retention in days (0 = keep forever).
    pub export_retention_days: i64,
    /// Optional LLM-assisted methods polish (OFF by default → deterministic).
    pub methods_llm_polish_enabled: bool,
    /// Reserved for the deferred verify slice: statistical-equivalence tolerance.
    pub verify_default_tolerance: f64,
    pub verify_time_budget_secs: i64,
    pub verify_size_budget_bytes: i64,

    // ── #54: rootfs-cache GC knobs (admin-editable) ───────────────────────
    /// Sweep cadence (seconds) of the rootfs-cache GC loop. Promoted from the
    /// hardcoded `rootfs_gc::GC_INTERVAL_SECS` (byte-preserving: default 21600 = 6h).
    /// Read-at-use each sweep cycle, so a PUT takes effect on the next pass.
    pub rootfs_gc_interval_secs: i64,
    /// Rootfs image-cache retention cap — how many content-digest dirs the cache keeps
    /// IN TOTAL once the protected set is satisfied. Promoted from the hardcoded
    /// `rootfs::cache::MAX_CACHED_DIGESTS_DEFAULT` (byte-preserving: default 4). The GC
    /// only bounds the local, re-obtainable cache; it never deletes provenance records,
    /// and the live/mounted digest is protected regardless of this cap.
    pub rootfs_cache_max_digests: i64,
    /// The acting admin stamped on the last PUT (audit; the `*_by` idiom). `None` on the
    /// seeded row until the first update. Serialize-only in the API projection; never set
    /// from a wire body.
    pub updated_by: Option<uuid::Uuid>,
}

impl ProvenanceSettings {
    /// Hardcoded defaults (also seeded by the migration). The cache fallback if
    /// the DB read fails.
    pub fn defaults() -> Self {
        Self {
            export_bundle_max_bytes: 1_073_741_824, // 1 GiB
            capture_code_max_bytes: 262_144, // 256 KiB
            export_retention_days: 30,
            methods_llm_polish_enabled: false,
            verify_default_tolerance: 0.99,
            verify_time_budget_secs: 3600,
            verify_size_budget_bytes: 4_294_967_296, // 4 GiB
            // #54: byte-equal to the retired constants (rootfs_gc.rs GC_INTERVAL_SECS = 6*3600,
            // rootfs::cache::MAX_CACHED_DIGESTS_DEFAULT = 4).
            rootfs_gc_interval_secs: 21_600, // 6 hours
            rootfs_cache_max_digests: 4,
            updated_by: None,
        }
    }

    /// Validate a candidate row. Returns a 422 `PROVENANCE_SETTING_OUT_OF_RANGE`
    /// on any out-of-range value (bounds match the migration CHECKs).
    pub fn validate(&self) -> Result<(), AppError> {
        fn range_i64(name: &str, v: i64, lo: i64, hi: i64) -> Result<(), AppError> {
            if v < lo || v > hi {
                return Err(AppError::unprocessable_entity(
                    "PROVENANCE_SETTING_OUT_OF_RANGE",
                    format!("{name}={v} out of range ({lo}..={hi})"),
                ));
            }
            Ok(())
        }
        range_i64(
            "export_bundle_max_bytes",
            self.export_bundle_max_bytes,
            1_048_576,
            68_719_476_736,
        )?;
        range_i64(
            "capture_code_max_bytes",
            self.capture_code_max_bytes,
            4_096,
            16_777_216,
        )?;
        range_i64("export_retention_days", self.export_retention_days, 0, 3650)?;
        // #54: rootfs-cache GC bounds (mirror the DB CHECKs). 60s..7d cadence; 1..1000 digests.
        range_i64("rootfs_gc_interval_secs", self.rootfs_gc_interval_secs, 60, 604_800)?;
        range_i64("rootfs_cache_max_digests", self.rootfs_cache_max_digests, 1, 1_000)?;
        range_i64("verify_time_budget_secs", self.verify_time_budget_secs, 1, 86_400)?;
        range_i64(
            "verify_size_budget_bytes",
            self.verify_size_budget_bytes,
            1_048_576,
            274_877_906_944,
        )?;
        if !(0.0..=1.0).contains(&self.verify_default_tolerance) {
            return Err(AppError::unprocessable_entity(
                "PROVENANCE_SETTING_OUT_OF_RANGE",
                format!(
                    "verify_default_tolerance={} out of range (0.0..=1.0)",
                    self.verify_default_tolerance
                ),
            ));
        }
        Ok(())
    }
}

/// PUT body — every field optional (absent = leave unchanged).
#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
pub struct UpdateProvenanceSettings {
    #[serde(default)]
    pub export_bundle_max_bytes: Option<i64>,
    #[serde(default)]
    pub capture_code_max_bytes: Option<i64>,
    #[serde(default)]
    pub export_retention_days: Option<i64>,
    #[serde(default)]
    pub methods_llm_polish_enabled: Option<bool>,
    #[serde(default)]
    pub verify_default_tolerance: Option<f64>,
    #[serde(default)]
    pub verify_time_budget_secs: Option<i64>,
    #[serde(default)]
    pub verify_size_budget_bytes: Option<i64>,
    // #54: rootfs-cache GC knobs (absent = unchanged).
    #[serde(default)]
    pub rootfs_gc_interval_secs: Option<i64>,
    #[serde(default)]
    pub rootfs_cache_max_digests: Option<i64>,
    // NOTE: `updated_by` is NEVER accepted from the wire — it is stamped from the
    // authenticated admin in the handler.
}

/// The LEGACY rootfs-cache-cap env override (`CYTO_ROOTFS_CACHE_MAX_DIGESTS`) as a seed
/// value — `Some(n)` only when the operator actually set it to a valid positive int,
/// clamped to the DB/validate bounds so a bad env can never seed an out-of-range row.
/// `None` when unset/malformed. Used at boot (DEC-2 correction) to seed the settings row so
/// an env-configured deployment that never PUTs stays byte-identical; the setting is
/// authoritative at read-at-use thereafter (an admin PUT stamps `updated_by` and supersedes
/// env for good). The interval has no env twin.
pub fn rootfs_cache_max_digests_env_seed() -> Option<i64> {
    rootfs_cache_max_digests_env_seed_from(
        std::env::var("CYTO_ROOTFS_CACHE_MAX_DIGESTS").ok().as_deref(),
    )
}

/// The pure core of [`rootfs_cache_max_digests_env_seed`] — parses the raw string, so it is
/// unit-testable without touching (global, racy) process env.
///
/// CAVEAT: the legacy `max_cached_digests()` env path had NO upper bound, so a deployment
/// that set `CYTO_ROOTFS_CACHE_MAX_DIGESTS` above 1000 kept more digests than the new ceiling
/// allows. The seed clamps to the DB/validate ceiling (1000) — otherwise it would violate the
/// CHECK and warn-fall-back to the default 4, a far larger behavior change. So "byte-identical
/// to before" holds for any env value in 1..=1000 (the realistic range: 1000 digests is ≈300
/// GB); a value above 1000 now evicts down to 1000 (cache only, re-obtainable — no data loss).
pub(crate) fn rootfs_cache_max_digests_env_seed_from(raw: Option<&str>) -> Option<i64> {
    raw.and_then(|v| v.trim().parse::<i64>().ok())
        .filter(|n| *n > 0)
        .map(|n| n.clamp(1, 1_000))
}

pub struct ProvenanceSettingsRepository {
    pool: SqlitePool,
}

impl ProvenanceSettingsRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn get(&self) -> Result<ProvenanceSettings, AppError> {
        sqlx::query_as!(
            ProvenanceSettings,
            r#"SELECT export_bundle_max_bytes, capture_code_max_bytes,
                      export_retention_days,
                      methods_llm_polish_enabled, verify_default_tolerance,
                      verify_time_budget_secs, verify_size_budget_bytes,
                      rootfs_gc_interval_secs, rootfs_cache_max_digests,
                      updated_by as "updated_by: uuid::Uuid"
               FROM provenance_settings WHERE id = TRUE"#
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// COALESCE-update the singleton, then re-read + return the new row. The
    /// caller validates the merged row before calling.
    pub async fn update(
        &self,
        req: &UpdateProvenanceSettings,
        updated_by: uuid::Uuid,
    ) -> Result<ProvenanceSettings, AppError> {
        sqlx::query_as!(
            ProvenanceSettings,
            r#"UPDATE provenance_settings SET
                    export_bundle_max_bytes = COALESCE($1, export_bundle_max_bytes),
                    capture_code_max_bytes = COALESCE($2, capture_code_max_bytes),
                    export_retention_days = COALESCE($3, export_retention_days),
                    methods_llm_polish_enabled = COALESCE($4, methods_llm_polish_enabled),
                    verify_default_tolerance = COALESCE($5, verify_default_tolerance),
                    verify_time_budget_secs = COALESCE($6, verify_time_budget_secs),
                    verify_size_budget_bytes = COALESCE($7, verify_size_budget_bytes),
                    rootfs_gc_interval_secs = COALESCE($8, rootfs_gc_interval_secs),
                    rootfs_cache_max_digests = COALESCE($9, rootfs_cache_max_digests),
                    updated_by = $10,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
               WHERE id = TRUE
               RETURNING export_bundle_max_bytes, capture_code_max_bytes,
                         export_retention_days,
                         methods_llm_polish_enabled, verify_default_tolerance,
                         verify_time_budget_secs, verify_size_budget_bytes,
                         rootfs_gc_interval_secs, rootfs_cache_max_digests,
                         updated_by as "updated_by: uuid::Uuid""#,
            req.export_bundle_max_bytes,
            req.capture_code_max_bytes,
            req.export_retention_days,
            req.methods_llm_polish_enabled,
            req.verify_default_tolerance,
            req.verify_time_budget_secs,
            req.verify_size_budget_bytes,
            req.rootfs_gc_interval_secs,
            req.rootfs_cache_max_digests,
            updated_by,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Seed the singleton's `rootfs_cache_max_digests` from the legacy
    /// `CYTO_ROOTFS_CACHE_MAX_DIGESTS` env override, but ONLY while the row has never been
    /// admin-modified (`updated_by IS NULL`). Idempotent per boot (it does NOT stamp
    /// `updated_by`, so env re-applies every boot until an admin PUTs, which then supersedes
    /// env for good). This keeps an env-configured deployment that never PUTs byte-identical
    /// to before this change (INV-2 / DEC-2 correction), while making the value
    /// admin-editable and authoritative at read-at-use — an admin change is never silently
    /// inert. The `COALESCE` leaves the row untouched when the env is unset.
    ///
    /// NOTE (intentional coupling): the gate is `updated_by IS NULL`, and `update()` stamps
    /// `updated_by` on ANY provenance-settings PUT. So an admin who edits any knob (even an
    /// unrelated one) closes the env-seed gate for good — thereafter the DB row is
    /// authoritative and `CYTO_ROOTFS_CACHE_MAX_DIGESTS` no longer re-seeds on reboot. This
    /// matches the workstore precedent: once an operator manages settings from the admin
    /// surface, the deployment env stops silently steering them.
    pub async fn seed_rootfs_cap_from_env_if_unmodified(
        &self,
        env_seed: Option<i64>,
    ) -> Result<(), AppError> {
        sqlx::query!(
            r#"UPDATE provenance_settings
                    SET rootfs_cache_max_digests = COALESCE($1, rootfs_cache_max_digests)
               WHERE id = TRUE AND updated_by IS NULL"#,
            env_seed,
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(())
    }

    /// Apply a partial update onto the current row → the merged candidate, for
    /// validation before the DB write.
    pub fn merge(
        current: &ProvenanceSettings,
        req: &UpdateProvenanceSettings,
    ) -> ProvenanceSettings {
        ProvenanceSettings {
            export_bundle_max_bytes: req
                .export_bundle_max_bytes
                .unwrap_or(current.export_bundle_max_bytes),
            capture_code_max_bytes: req
                .capture_code_max_bytes
                .unwrap_or(current.capture_code_max_bytes),
            export_retention_days: req
                .export_retention_days
                .unwrap_or(current.export_retention_days),
            methods_llm_polish_enabled: req
                .methods_llm_polish_enabled
                .unwrap_or(current.methods_llm_polish_enabled),
            verify_default_tolerance: req
                .verify_default_tolerance
                .unwrap_or(current.verify_default_tolerance),
            verify_time_budget_secs: req
                .verify_time_budget_secs
                .unwrap_or(current.verify_time_budget_secs),
            verify_size_budget_bytes: req
                .verify_size_budget_bytes
                .unwrap_or(current.verify_size_budget_bytes),
            // #54: rootfs-cache GC knobs (present = overlay, absent = keep).
            rootfs_gc_interval_secs: req
                .rootfs_gc_interval_secs
                .unwrap_or(current.rootfs_gc_interval_secs),
            rootfs_cache_max_digests: req
                .rootfs_cache_max_digests
                .unwrap_or(current.rootfs_cache_max_digests),
            // merge never adopts updated_by from the wire body (stamped in the handler).
            updated_by: current.updated_by,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-13: validate() range + merge overlays only present fields.
    #[test]
    fn defaults_are_valid() {
        ProvenanceSettings::defaults().validate().expect("defaults valid");
    }

    #[test]
    fn out_of_range_values_rejected_422() {
        let bad_bundle = ProvenanceSettings {
            export_bundle_max_bytes: 1,
            ..ProvenanceSettings::defaults()
        };
        let err = bad_bundle.validate().unwrap_err();
        assert_eq!(err.status_code(), 422);
        assert_eq!(err.error_code(), "PROVENANCE_SETTING_OUT_OF_RANGE");

        let bad_retention = ProvenanceSettings {
            export_retention_days: 100_000,
            ..ProvenanceSettings::defaults()
        };
        assert_eq!(bad_retention.validate().unwrap_err().status_code(), 422);

        let bad_tol = ProvenanceSettings {
            verify_default_tolerance: 2.0,
            ..ProvenanceSettings::defaults()
        };
        assert_eq!(bad_tol.validate().unwrap_err().status_code(), 422);
    }

    #[test]
    fn merge_overlays_only_present_fields() {
        let cur = ProvenanceSettings::defaults();
        let req = UpdateProvenanceSettings {
            export_retention_days: Some(90),
            ..Default::default()
        };
        let merged = ProvenanceSettingsRepository::merge(&cur, &req);
        assert_eq!(merged.export_retention_days, 90);
        assert_eq!(
            merged.export_bundle_max_bytes, cur.export_bundle_max_bytes,
            "untouched fields preserved"
        );
    }

    // TEST-1: the extended defaults are valid.
    #[test]
    fn gc_defaults_are_valid() {
        let d = ProvenanceSettings::defaults();
        assert_eq!(d.rootfs_gc_interval_secs, 21_600);
        assert_eq!(d.rootfs_cache_max_digests, 4);
        assert!(d.updated_by.is_none());
        d.validate().expect("extended defaults valid");
    }

    // TEST-2 [acceptance][INV-2]: the promoted GC defaults byte-equal the retired compile-time
    // constants — a deployment that never PUTs is byte-identical to today. Flip either default
    // (or either source const) and this goes red.
    #[test]
    fn gc_defaults_byte_equal_retired_constants() {
        let d = ProvenanceSettings::defaults();
        assert_eq!(
            d.rootfs_gc_interval_secs,
            super::super::rootfs_gc::GC_INTERVAL_SECS as i64,
            "sweep interval default must equal the retired GC_INTERVAL_SECS"
        );
        assert_eq!(
            d.rootfs_cache_max_digests,
            crate::modules::rootfs::cache::MAX_CACHED_DIGESTS_DEFAULT as i64,
            "cache cap default must equal the retired MAX_CACHED_DIGESTS_DEFAULT"
        );
    }

    // TEST-3 [acceptance][INV-3]: validate() rejects out-of-range GC knobs with a typed 422
    // (the Rust half of the double-bounds guard; the DB CHECK is the other half).
    #[test]
    fn gc_out_of_range_rejected_422() {
        for bad_interval in [0_i64, 59, 604_801, 999_999_999] {
            let m = ProvenanceSettings {
                rootfs_gc_interval_secs: bad_interval,
                ..ProvenanceSettings::defaults()
            };
            let err = m.validate().unwrap_err();
            assert_eq!(err.status_code(), 422, "interval {bad_interval} must 422");
            assert_eq!(err.error_code(), "PROVENANCE_SETTING_OUT_OF_RANGE");
        }
        for bad_digests in [0_i64, 1001, 100_000] {
            let m = ProvenanceSettings {
                rootfs_cache_max_digests: bad_digests,
                ..ProvenanceSettings::defaults()
            };
            assert_eq!(
                m.validate().unwrap_err().status_code(),
                422,
                "digests {bad_digests} must 422"
            );
        }
        // In-range boundary values pass.
        for (i, dcount) in [(60_i64, 1_i64), (604_800, 1000)] {
            let m = ProvenanceSettings {
                rootfs_gc_interval_secs: i,
                rootfs_cache_max_digests: dcount,
                ..ProvenanceSettings::defaults()
            };
            m.validate().expect("boundary values valid");
        }
    }

    // TEST-4: merge overlays only present GC fields and never adopts updated_by from the body
    // (the Update… body has no updated_by field — it is stamped in the handler).
    #[test]
    fn gc_merge_overlays_and_never_updated_by() {
        let cur = ProvenanceSettings {
            updated_by: Some(uuid::Uuid::new_v4()),
            ..ProvenanceSettings::defaults()
        };
        let req = UpdateProvenanceSettings {
            rootfs_cache_max_digests: Some(9),
            ..Default::default()
        };
        let m = ProvenanceSettingsRepository::merge(&cur, &req);
        assert_eq!(m.rootfs_cache_max_digests, 9);
        assert_eq!(
            m.rootfs_gc_interval_secs, cur.rootfs_gc_interval_secs,
            "untouched GC field preserved"
        );
        assert_eq!(m.updated_by, cur.updated_by, "merge preserves updated_by, never from body");
    }
}
