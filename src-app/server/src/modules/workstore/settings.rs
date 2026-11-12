//! Workstore admin settings singleton (issue #54): the GC policy + ingest size
//! caps, promoted from hardcoded constants to an admin-tunable settings row.
//!
//! Mirrors `modules/sandbox/settings.rs` (struct + `defaults()` cache-fallback +
//! `validate()` 422-bounds + partial `Update` + `Repository` COALESCE-update +
//! `merge()`). Defaults EQUAL the compiled constants so a never-PUT deployment is
//! byte-identical (INV-1). Repository uses `sqlx::query_as!` (build-DB checked —
//! `build.rs::provision_build_db` auto-migrates the sqlite build file).
//!
//! SQLite port (record; sqlite-store): `WHERE id = TRUE` stays verbatim (legal
//! SQLite — the ITEM-19 jobs precedent for the singleton pin), `NOW()` becomes
//! the canonical RFC3339 `strftime` write clock, and the i64/bool columns
//! follow the DEC-8 map with no typed overrides (INTEGER→i64 / INTEGER→bool are
//! the macro's own inference, probed at ITEM-18/19).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;
use txresbench_core::AppError;

/// The singleton workstore settings row — the five promoted knobs (GC policy +
/// ingest/body size caps). Byte fields are `bigint`/`i64` (DEC-9), converted to
/// `u64` at the read-at-use sites via the `*_u64` accessors below.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, sqlx::FromRow)]
pub struct WorkstoreSettings {
    /// Enable the standing blob-GC union sweep.
    pub gc_enabled: bool,
    /// GC sweep cadence, in hours.
    pub gc_interval_hours: i64,
    /// Orphan-grace window, in seconds: the FULL sweep spares a blob younger than
    /// this (it may be a live-but-uncommitted ingest write). SAFETY floor (DEC-3).
    pub gc_grace_secs: i64,
    /// Ingest ceiling on a SINGLE output file (and each multi-file member), in
    /// bytes — an OOM guard (`put` reads the whole payload into memory). SAFETY
    /// ceiling (DEC-3).
    pub max_output_file_bytes: i64,
    /// Ingest ceiling on a multi-file (directory) artifact's TOTAL bytes — an OOM
    /// guard (`put_prefix` holds every member at once). SAFETY ceiling (DEC-3).
    pub max_multifile_total_bytes: i64,

    /// **SaaS only.** Ceiling on a dataset UPLOAD's whole request body, in bytes.
    ///
    /// Promoted from `dataset::routes::UPLOAD_BODY_LIMIT`, a compiled 64 GiB `const`
    /// applied through `DefaultBodyLimit::max(...)` — the deferred half of #185 §1
    /// and the drop-in DEC-7 of #182 anticipated. It is read AT USE, per request, by
    /// the upload guard, so a PUT takes effect on the next upload with no restart;
    /// the old layer baked its value into the router at build time, which is
    /// precisely the "compiled constant read once" #185 records.
    ///
    /// **It does not apply to a desktop/self-hosted build at all.** The owner's
    /// ruling — "we should not limit file size, that depends on user computer to
    /// process" — makes the user's own disk the limit there, so
    /// `dataset::routes::upload_body_ceiling` returns `None` on a non-saas build and
    /// the upload path carries `DefaultBodyLimit::disable()`. The column still
    /// exists in every build (migrations are never cfg-gated) and the admin card
    /// still shows it, labelled with that scope — see DEC-11 for why a labelled
    /// control beats a hidden one while #50 blocks a saas-only render.
    ///
    /// Under saas this value is a CAPACITY knob, not a security boundary: over it is
    /// `413 UPLOAD_TOO_LARGE`. If the row is unreadable the ceiling falls back to
    /// [`Self::defaults`] — never to unlimited (DEC-3 / INV-3).
    pub max_upload_body_bytes: i64,

    /// Ceiling on the NUMBER of parts in one multipart upload, in BOTH modes.
    ///
    /// Promoted from `file::stream::MAX_UPLOAD_PARTS` (a compiled `1024`), value
    /// unchanged (DEC-5). The owner's ruling is about file SIZE; this bounds
    /// resident per-part state and temp inodes — the second, independent path to
    /// process death #182 identified ("small times unbounded is unbounded") — which
    /// the ruling does not touch and which gets MORE load-bearing once the body
    /// ceiling is gone, since that ceiling was the outer bound on how many parts
    /// could arrive at all.
    pub max_upload_parts: i64,
}

impl WorkstoreSettings {
    /// Hardcoded defaults — the SEED of the migration AND the cache fallback if the
    /// DB read fails. Each value equals the pre-existing compiled constant (INV-1):
    /// `WorkstoreLimits::default` (gc), `gc.rs FULL_SWEEP_GRACE_SECS`,
    /// `ingest.rs MAX_OUTPUT_FILE_BYTES` / `MAX_MULTIFILE_TOTAL_BYTES`.
    pub fn defaults() -> Self {
        Self {
            gc_enabled: true,
            gc_interval_hours: 6,
            gc_grace_secs: 3600,                        // 1 hour
            max_output_file_bytes: 8 * 1024 * 1024 * 1024, // 8 GiB
            max_multifile_total_bytes: 32 * 1024 * 1024 * 1024, // 32 GiB
            // 64 GiB — byte-equal to the retired `UPLOAD_BODY_LIMIT` const, so a
            // SaaS deployment that never PUTs this knob keeps exactly the ceiling it
            // already had, and an unreadable row degrades to that same value rather
            // than to unlimited (INV-3).
            max_upload_body_bytes: 64 * 1024 * 1024 * 1024, // 64 GiB
            // 1024 — byte-equal to the retired `MAX_UPLOAD_PARTS` const (DEC-5).
            max_upload_parts: 1024,
        }
    }

    // ── read-at-use accessors (DEC-9: stored i64, consumed u64) ──────────────
    /// GC cadence in hours, floored at 1 (a degenerate 0 can never yield a
    /// zero-period loop).
    pub fn gc_interval_hours_u64(&self) -> u64 {
        self.gc_interval_hours.max(1) as u64
    }
    /// Orphan-grace window in seconds.
    pub fn gc_grace_secs_u64(&self) -> u64 {
        self.gc_grace_secs.max(0) as u64
    }
    /// Per-file / per-member ingest ceiling in bytes.
    pub fn max_output_file_bytes_u64(&self) -> u64 {
        self.max_output_file_bytes.max(0) as u64
    }
    /// Multi-file aggregate ingest ceiling in bytes.
    pub fn max_multifile_total_bytes_u64(&self) -> u64 {
        self.max_multifile_total_bytes.max(0) as u64
    }
    /// The SaaS upload body ceiling in bytes.
    ///
    /// Floored at 1 to keep a NEGATIVE stored value from underflowing when it is cast
    /// to `u64` — `-1 as u64` is `u64::MAX`, i.e. a degenerate row would silently
    /// become "unlimited", which is the one outcome INV-3 forbids. That underflow is
    /// the hazard this floor exists for.
    ///
    /// It is NOT a mitigation that keeps uploads working on a degenerate row, and an
    /// earlier version of this comment claimed it was: a 1-byte ceiling refuses every
    /// non-empty upload just as a 0-byte one would. The DB CHECK and `validate()` are
    /// what actually keep the value sane; this is the belt to those braces, and it is
    /// why the saas resolver can return a plain `u64`.
    pub fn max_upload_body_bytes_u64(&self) -> u64 {
        self.max_upload_body_bytes.max(1) as u64
    }
    /// The multipart part-count ceiling, floored at 1 (a 0 would refuse every
    /// upload, including a well-formed single-file one).
    pub fn max_upload_parts_usize(&self) -> usize {
        self.max_upload_parts.max(1) as usize
    }

    /// Validate a candidate row. Returns a 422 `WORKSTORE_SETTING_OUT_OF_RANGE` on
    /// any out-of-range value. The bounds mirror the DB CHECK constraints (DEC-3):
    /// a SAFETY guard (the ingest OOM ceilings, the GC orphan-grace floor) is
    /// bounded and NEVER admin-raisable unbounded.
    pub fn validate(&self) -> Result<(), AppError> {
        fn range(name: &str, v: i64, lo: i64, hi: i64) -> Result<(), AppError> {
            if v < lo || v > hi {
                return Err(AppError::unprocessable_entity(
                    "WORKSTORE_SETTING_OUT_OF_RANGE",
                    format!("{name}={v} out of range ({lo}..={hi})"),
                ));
            }
            Ok(())
        }
        // GC cadence: 1h .. 30d.
        range("gc_interval_hours", self.gc_interval_hours, 1, 720)?;
        // GC orphan-grace FLOOR: 5 min .. 7 days.
        range("gc_grace_secs", self.gc_grace_secs, 300, 604_800)?;
        // Ingest OOM ceilings: 1 MiB .. 64 GiB per file, 1 MiB .. 256 GiB total.
        range("max_output_file_bytes", self.max_output_file_bytes, 1024 * 1024, 64i64 * 1024 * 1024 * 1024)?;
        range(
            "max_multifile_total_bytes",
            self.max_multifile_total_bytes,
            1024 * 1024,
            256i64 * 1024 * 1024 * 1024,
        )?;
        // Upload body ceiling (SaaS): 1 MiB .. 256 GiB — the same envelope as
        // max_multifile_total_bytes. The bound survives the uncapping ruling on
        // purpose (INV-4): the ruling removes the DESKTOP cap, it does not make the
        // SaaS knob admin-raisable to unbounded.
        range("max_upload_body_bytes", self.max_upload_body_bytes, 1024 * 1024, 256i64 * 1024 * 1024 * 1024)?;
        // Part count: 1 .. 65536. Bounds resident per-part state + temp inodes, not
        // file size (DEC-5), so the file-size ruling leaves it alone.
        range("max_upload_parts", self.max_upload_parts, 1, 65_536)?;
        // A total smaller than a single-member cap is degenerate.
        if self.max_multifile_total_bytes < self.max_output_file_bytes {
            return Err(AppError::unprocessable_entity(
                "WORKSTORE_SETTING_OUT_OF_RANGE",
                format!(
                    "max_multifile_total_bytes={} must be >= max_output_file_bytes={}",
                    self.max_multifile_total_bytes, self.max_output_file_bytes
                ),
            ));
        }
        Ok(())
    }
}

/// PUT body — every field optional (absent = leave unchanged).
#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
pub struct UpdateWorkstoreSettings {
    #[serde(default)]
    pub gc_enabled: Option<bool>,
    #[serde(default)]
    pub gc_interval_hours: Option<i64>,
    #[serde(default)]
    pub gc_grace_secs: Option<i64>,
    #[serde(default)]
    pub max_output_file_bytes: Option<i64>,
    #[serde(default)]
    pub max_multifile_total_bytes: Option<i64>,
    /// SaaS upload body ceiling in bytes (#185 §1). Absent = unchanged.
    #[serde(default)]
    pub max_upload_body_bytes: Option<i64>,
    /// Multipart part-count ceiling (#185 §1). Absent = unchanged.
    #[serde(default)]
    pub max_upload_parts: Option<i64>,
}

impl UpdateWorkstoreSettings {
    /// True when no field is set (the partial would change nothing).
    pub fn is_empty(&self) -> bool {
        self.gc_enabled.is_none()
            && self.gc_interval_hours.is_none()
            && self.gc_grace_secs.is_none()
            && self.max_output_file_bytes.is_none()
            && self.max_multifile_total_bytes.is_none()
            && self.max_upload_body_bytes.is_none()
            && self.max_upload_parts.is_none()
    }
}

/// The LEGACY GC env overrides (`TXR_WORKSTORE_GC_ENABLED` /
/// `TXR_WORKSTORE_GC_INTERVAL_HOURS`) as a partial update — a field is PRESENT only
/// when the operator actually set that var. Empty when neither is set. Used at boot
/// (DEC-8) to seed the settings row so an env-configured deployment that never PUTs
/// stays byte-identical (INV-1); superseded for good once an admin PUTs (which
/// stamps `updated_by`). The interval is clamped to the DB/validate bounds so a bad
/// env value can never seed an out-of-range row.
pub fn gc_env_overrides() -> UpdateWorkstoreSettings {
    gc_env_overrides_from(
        std::env::var("TXR_WORKSTORE_GC_ENABLED").ok().as_deref(),
        std::env::var("TXR_WORKSTORE_GC_INTERVAL_HOURS").ok().as_deref(),
    )
}

/// The pure core of [`gc_env_overrides`] — parses the raw env strings, so it is
/// unit-testable without touching (global, racy) process env.
pub(crate) fn gc_env_overrides_from(
    enabled: Option<&str>,
    interval: Option<&str>,
) -> UpdateWorkstoreSettings {
    let mut ov = UpdateWorkstoreSettings::default();
    if let Some(v) = enabled {
        ov.gc_enabled = match v.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Some(true),
            "0" | "false" | "no" | "off" => Some(false),
            _ => None,
        };
    }
    if let Some(v) = interval {
        if let Ok(h) = v.trim().parse::<i64>() {
            ov.gc_interval_hours = Some(h.clamp(1, 720));
        }
    }
    ov
}

pub struct WorkstoreSettingsRepository {
    pool: SqlitePool,
}

impl WorkstoreSettingsRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Read the singleton row (the SELECT omits `updated_at`/`updated_by` so no
    /// timestamptz/uuid override is needed — the projection is the 5 knobs).
    pub async fn get(&self) -> Result<WorkstoreSettings, AppError> {
        sqlx::query_as!(
            WorkstoreSettings,
            r#"SELECT gc_enabled as "gc_enabled: bool", gc_interval_hours, gc_grace_secs,
                      max_output_file_bytes, max_multifile_total_bytes,
                      max_upload_body_bytes, max_upload_parts
               FROM workstore_settings WHERE id = TRUE"#
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// COALESCE-update the singleton, stamp `updated_by`/`updated_at`, then re-read
    /// + return the new row. The caller validates the MERGED row before calling
    /// (so the DB never holds an invalid value; the DB CHECKs are the backstop).
    pub async fn update(
        &self,
        req: &UpdateWorkstoreSettings,
        updated_by: Uuid,
    ) -> Result<WorkstoreSettings, AppError> {
        sqlx::query_as!(
            WorkstoreSettings,
            r#"UPDATE workstore_settings SET
                    gc_enabled = COALESCE($1, gc_enabled),
                    gc_interval_hours = COALESCE($2, gc_interval_hours),
                    gc_grace_secs = COALESCE($3, gc_grace_secs),
                    max_output_file_bytes = COALESCE($4, max_output_file_bytes),
                    max_multifile_total_bytes = COALESCE($5, max_multifile_total_bytes),
                    max_upload_body_bytes = COALESCE($6, max_upload_body_bytes),
                    max_upload_parts = COALESCE($7, max_upload_parts),
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                    updated_by = $8
               WHERE id = TRUE
               RETURNING gc_enabled as "gc_enabled: bool", gc_interval_hours, gc_grace_secs,
                         max_output_file_bytes, max_multifile_total_bytes,
                         max_upload_body_bytes, max_upload_parts"#,
            req.gc_enabled,
            req.gc_interval_hours,
            req.gc_grace_secs,
            req.max_output_file_bytes,
            req.max_multifile_total_bytes,
            req.max_upload_body_bytes,
            req.max_upload_parts,
            updated_by,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Seed the singleton from the legacy GC env overrides, but ONLY while it has
    /// never been admin-modified (`updated_by IS NULL`). Idempotent per boot (it does
    /// NOT stamp `updated_by`, so env re-applies every boot until an admin PUTs, which
    /// then supersedes env for good). This keeps an env-configured deployment that
    /// never PUTs byte-identical to before this feature (INV-1 / DEC-8). The COALESCE
    /// leaves any field the env didn't set untouched.
    pub async fn seed_from_env_if_unmodified(
        &self,
        ov: &UpdateWorkstoreSettings,
    ) -> Result<(), AppError> {
        sqlx::query!(
            r#"UPDATE workstore_settings SET
                    gc_enabled = COALESCE($1, gc_enabled),
                    gc_interval_hours = COALESCE($2, gc_interval_hours)
               WHERE id = TRUE AND updated_by IS NULL"#,
            ov.gc_enabled,
            ov.gc_interval_hours,
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(())
    }

    /// Apply a partial update onto the current row → the merged candidate, for
    /// validation before the DB write.
    pub fn merge(current: &WorkstoreSettings, req: &UpdateWorkstoreSettings) -> WorkstoreSettings {
        WorkstoreSettings {
            gc_enabled: req.gc_enabled.unwrap_or(current.gc_enabled),
            gc_interval_hours: req.gc_interval_hours.unwrap_or(current.gc_interval_hours),
            gc_grace_secs: req.gc_grace_secs.unwrap_or(current.gc_grace_secs),
            max_output_file_bytes: req
                .max_output_file_bytes
                .unwrap_or(current.max_output_file_bytes),
            max_multifile_total_bytes: req
                .max_multifile_total_bytes
                .unwrap_or(current.max_multifile_total_bytes),
            max_upload_body_bytes: req
                .max_upload_body_bytes
                .unwrap_or(current.max_upload_body_bytes),
            max_upload_parts: req.max_upload_parts.unwrap_or(current.max_upload_parts),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-5: defaults pass validate() and equal the compiled constants (INV-1).
    #[test]
    fn defaults_are_valid() {
        let d = WorkstoreSettings::defaults();
        d.validate().expect("defaults valid");
        assert!(d.gc_enabled);
        assert_eq!(d.gc_interval_hours, 6);
        assert_eq!(d.gc_grace_secs, 3600);
        assert_eq!(d.max_output_file_bytes, 8_589_934_592);
        assert_eq!(d.max_multifile_total_bytes, 34_359_738_368);
    }

    // TEST-2 [acceptance INV-3]: no safety guard is admin-raisable unbounded — a
    // raise ABOVE the ingest ceiling and a drop BELOW the grace floor are 422s.
    #[test]
    fn out_of_range_rejected_422() {
        // Ingest OOM ceiling: 65 GiB > the 64 GiB max.
        let over_file = WorkstoreSettings {
            max_output_file_bytes: 65i64 * 1024 * 1024 * 1024,
            max_multifile_total_bytes: 128i64 * 1024 * 1024 * 1024,
            ..WorkstoreSettings::defaults()
        };
        let e = over_file.validate().unwrap_err();
        assert_eq!(e.status_code(), 422);
        assert_eq!(e.error_code(), "WORKSTORE_SETTING_OUT_OF_RANGE");

        // Multi-file total ceiling: 300 GiB > the 256 GiB max.
        let over_total = WorkstoreSettings {
            max_multifile_total_bytes: 300i64 * 1024 * 1024 * 1024,
            ..WorkstoreSettings::defaults()
        };
        assert_eq!(over_total.validate().unwrap_err().status_code(), 422);

        // GC orphan-grace FLOOR: 0 is below the 300s floor (would let the full
        // sweep free a live-but-uncommitted ingest write).
        let under_grace = WorkstoreSettings { gc_grace_secs: 0, ..WorkstoreSettings::defaults() };
        assert_eq!(under_grace.validate().unwrap_err().status_code(), 422);

        // GC cadence floor: 0 hours is below the 1h floor.
        let under_interval =
            WorkstoreSettings { gc_interval_hours: 0, ..WorkstoreSettings::defaults() };
        assert_eq!(under_interval.validate().unwrap_err().status_code(), 422);

        // Degenerate: total < per-file.
        let total_lt_file = WorkstoreSettings {
            max_output_file_bytes: 4i64 * 1024 * 1024 * 1024,
            max_multifile_total_bytes: 2i64 * 1024 * 1024 * 1024,
            ..WorkstoreSettings::defaults()
        };
        assert_eq!(total_lt_file.validate().unwrap_err().status_code(), 422);
    }

    // TEST-15 [covers ITEM-6/DEC-8]: the legacy GC env overrides parse only the
    // PRESENT vars, clamp the interval to the valid range, and are otherwise empty —
    // so a deployment with no env vars produces an empty (no-op) seed (byte-identical),
    // and an env-configured one produces exactly the fields it set.
    #[test]
    fn gc_env_overrides_parse_present_vars_only() {
        // Neither set → empty (no seed, byte-identical default path).
        assert!(gc_env_overrides_from(None, None).is_empty());

        // Both set → both present; interval clamped into 1..=720.
        let ov = gc_env_overrides_from(Some("false"), Some("999"));
        assert_eq!(ov.gc_enabled, Some(false));
        assert_eq!(ov.gc_interval_hours, Some(720), "over-range interval clamps to 720");
        assert!(ov.gc_grace_secs.is_none() && ov.max_output_file_bytes.is_none());

        // Only one set → only that field present.
        let just_interval = gc_env_overrides_from(None, Some("3"));
        assert_eq!(just_interval.gc_enabled, None);
        assert_eq!(just_interval.gc_interval_hours, Some(3));

        // A garbage value is ignored (not a footgun-seed).
        assert!(gc_env_overrides_from(Some("maybe"), Some("not-a-number")).is_empty());
    }

    // TEST-6: merge overlays only the present fields.
    #[test]
    fn merge_overlays_only_present_fields() {
        let cur = WorkstoreSettings::defaults();
        let req = UpdateWorkstoreSettings { gc_interval_hours: Some(12), ..Default::default() };
        let merged = WorkstoreSettingsRepository::merge(&cur, &req);
        assert_eq!(merged.gc_interval_hours, 12);
        assert_eq!(merged.gc_enabled, cur.gc_enabled, "untouched fields preserved");
        assert_eq!(merged.max_output_file_bytes, cur.max_output_file_bytes);
    }

    // ── uncapped-uploads (#185 §1) ──────────────────────────────────────────────
    // NOTE on ids: TEST-N is a PER-FEATURE namespace and this file already carries
    // #54's TEST-2/5/6/15. The four tests below belong to the `uncapped-uploads`
    // feature and are named with that prefix so a grep for an id cannot silently
    // bind one feature's claim to another feature's assertion (lifecycle A11).

    // uncapped-uploads TEST-6 [acceptance INV-4]: "Keep a bound." The uncapping
    // ruling removes the DESKTOP ceiling; it does NOT make either promoted knob
    // admin-raisable to unbounded. Both new fields keep a floor AND a ceiling, and
    // the shipped defaults sit inside them.
    #[test]
    fn uncapped_uploads_test6_promoted_knobs_keep_their_bounds() {
        let d = WorkstoreSettings::defaults();
        d.validate().expect("shipped defaults are inside the bounds");
        // The defaults ARE the retired compiled constants (INV-2 "defaulting high").
        assert_eq!(d.max_upload_body_bytes, 68_719_476_736, "64 GiB == retired UPLOAD_BODY_LIMIT");
        assert_eq!(d.max_upload_parts, 1024, "== retired MAX_UPLOAD_PARTS");

        // Ceiling: 257 GiB is above the 256 GiB max → 422, not accepted-as-unbounded.
        let over = WorkstoreSettings {
            max_upload_body_bytes: 257i64 * 1024 * 1024 * 1024,
            ..d.clone()
        };
        let e = over.validate().unwrap_err();
        assert_eq!(e.status_code(), 422);
        assert_eq!(e.error_code(), "WORKSTORE_SETTING_OUT_OF_RANGE");

        // Floor: below 1 MiB is degenerate (would refuse an ordinary upload).
        let under =
            WorkstoreSettings { max_upload_body_bytes: 1024 * 1024 - 1, ..d.clone() };
        assert_eq!(under.validate().unwrap_err().status_code(), 422);

        // The part cap keeps BOTH bounds too (DEC-5: a different axis, still bounded).
        let parts_over = WorkstoreSettings { max_upload_parts: 65_537, ..d.clone() };
        assert_eq!(parts_over.validate().unwrap_err().status_code(), 422);
        let parts_under = WorkstoreSettings { max_upload_parts: 0, ..d.clone() };
        assert_eq!(parts_under.validate().unwrap_err().status_code(), 422);

        // Exactly-at-bound values are ACCEPTED (the bound is inclusive, so the test
        // above is measuring the edge and not merely "some big number fails").
        let at_hi = WorkstoreSettings {
            max_upload_body_bytes: 256i64 * 1024 * 1024 * 1024,
            max_upload_parts: 65_536,
            ..d.clone()
        };
        at_hi.validate().expect("the inclusive upper bound is accepted");
    }

    // uncapped-uploads TEST-15: a patch naming ONE promoted knob leaves the other
    // promoted knob and all five pre-existing knobs untouched — the promotion did
    // not turn a partial PUT into a full overwrite.
    #[test]
    fn uncapped_uploads_test15_merge_leaves_sibling_knobs_untouched() {
        let cur = WorkstoreSettings {
            max_upload_body_bytes: 12i64 * 1024 * 1024 * 1024,
            max_upload_parts: 77,
            ..WorkstoreSettings::defaults()
        };
        let req = UpdateWorkstoreSettings { max_upload_parts: Some(2048), ..Default::default() };
        let merged = WorkstoreSettingsRepository::merge(&cur, &req);

        assert_eq!(merged.max_upload_parts, 2048, "the named field is overlaid");
        assert_eq!(
            merged.max_upload_body_bytes, cur.max_upload_body_bytes,
            "the sibling promoted knob is NOT reset to its default"
        );
        assert_eq!(merged.gc_enabled, cur.gc_enabled);
        assert_eq!(merged.gc_interval_hours, cur.gc_interval_hours);
        assert_eq!(merged.gc_grace_secs, cur.gc_grace_secs);
        assert_eq!(merged.max_output_file_bytes, cur.max_output_file_bytes);
        assert_eq!(merged.max_multifile_total_bytes, cur.max_multifile_total_bytes);

        // ...and the same in the other direction.
        let req2 =
            UpdateWorkstoreSettings { max_upload_body_bytes: Some(1 << 30), ..Default::default() };
        let merged2 = WorkstoreSettingsRepository::merge(&cur, &req2);
        assert_eq!(merged2.max_upload_body_bytes, 1 << 30);
        assert_eq!(merged2.max_upload_parts, cur.max_upload_parts);
    }

    // uncapped-uploads: an empty patch is still empty once two fields were added —
    // `is_empty` gates the no-op PUT, so a forgotten field would make every PUT
    // look non-empty (and stamp `updated_by` on a request that changes nothing).
    #[test]
    fn uncapped_uploads_is_empty_covers_the_promoted_knobs() {
        assert!(UpdateWorkstoreSettings::default().is_empty());
        assert!(!UpdateWorkstoreSettings {
            max_upload_body_bytes: Some(1 << 20),
            ..Default::default()
        }
        .is_empty());
        assert!(!UpdateWorkstoreSettings { max_upload_parts: Some(1), ..Default::default() }
            .is_empty());
    }

    // uncapped-uploads: the `*_u64`/`*_usize` read-at-use accessors floor a
    // degenerate stored value at 1 rather than 0, and — the case that actually
    // matters — a NEGATIVE value does not underflow to `u64::MAX`. A bare
    // `stored as u64` turns -1 into 18446744073709551615, i.e. a hand-edited or
    // corrupted row would silently become an unlimited SaaS ceiling, which is exactly
    // what INV-3 forbids. The floor is also what lets the saas resolver return a
    // plain `u64` with no None arm.
    #[test]
    fn uncapped_uploads_accessors_floor_degenerate_values_at_one() {
        let degenerate =
            WorkstoreSettings { max_upload_body_bytes: 0, max_upload_parts: 0, ..WorkstoreSettings::defaults() };
        assert_eq!(degenerate.max_upload_body_bytes_u64(), 1);
        assert_eq!(degenerate.max_upload_parts_usize(), 1);

        // The part cap exists as three independent literals — this constant, the
        // `defaults()` field, and the migration's column default — and nothing
        // structurally forces them equal. Pin two of the three here; TEST-16 pins
        // `defaults()` to the migration on a real database, which closes the
        // triangle. Without this, a change to one literal leaves the streaming tests
        // exercising a value the server no longer enforces, passing for the wrong
        // reason.
        assert_eq!(
            WorkstoreSettings::defaults().max_upload_parts as usize,
            crate::modules::file::stream::MAX_UPLOAD_PARTS,
            "the documented part-cap constant and the enforced default must agree"
        );

        // The underflow case, stated explicitly so a refactor to `as u64` reds here.
        let negative = WorkstoreSettings {
            max_upload_body_bytes: -1,
            max_upload_parts: -1,
            ..WorkstoreSettings::defaults()
        };
        assert_eq!(
            negative.max_upload_body_bytes_u64(),
            1,
            "a negative row must not underflow to u64::MAX — that is an unlimited \
             ceiling arrived at by accident (INV-3)"
        );
        assert_eq!(negative.max_upload_parts_usize(), 1);

        let d = WorkstoreSettings::defaults();
        assert_eq!(d.max_upload_body_bytes_u64(), 68_719_476_736);
        assert_eq!(d.max_upload_parts_usize(), 1024);
    }
}
