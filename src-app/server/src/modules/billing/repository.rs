//! The account↔Stripe-customer link write + BIDIRECTIONAL resolvers (ITEM-6 —
//! **PROV-B2-1**, bound by B3 + B4). All business SQL lives here (CODING_GUIDELINES
//! §9); handlers take a `&PgPool` and call these.
//!
//! INV-1 ("account IS the Stripe customer"): one Customer per `accounts` row, keyed
//! on `accounts.stripe_customer_id` (UNIQUE — the ALTER in
//! `202608260003_billing_accounts_columns.sql`). The write is CAS/`ON CONFLICT`-safe
//! so a concurrent double-checkout reuses ONE Customer (BQ-INV-9, no TOCTOU).
//!
//! Both directions are provided (PROV-B2-1 GROWN in the Phase-3 reconcile):
//!  - FORWARD  `resolve_customer(account_id) -> Option<customer_id>` +
//!             `ensure_stripe_customer(account_id) -> customer_id` — B4's quota path
//!             resolves the account's Customer; the checkout path ensures it.
//!  - REVERSE  `account_by_customer(customer_id) -> Option<account_id>` — B3's
//!             webhook path resolves the account from a Stripe `customer` on a
//!             `checkout.session.completed`/subscription event. The UNIQUE index
//!             makes the reverse lookup exact.

use chrono::{DateTime, Duration, Utc};
use sqlx::PgPool;
use uuid::Uuid;
use ziee_core::AppError;

use super::client::StripeClient;
use super::dunning::{GraceAction, PlanChange, Transition};
use super::models::{BillingSettings, UpdateBillingSettingsRequest, UsageRollupRow};
use super::rollup::{current_period, gb_months, SECONDS_PER_HOUR};

/// FORWARD lookup — the account's Stripe Customer id, or `None` if it has never
/// checked out (PROV-B2-1). `None` also for a nonexistent account id.
pub async fn resolve_customer(pool: &PgPool, account_id: Uuid) -> Result<Option<String>, AppError> {
    let row = sqlx::query!(
        r#"SELECT stripe_customer_id FROM accounts WHERE id = $1"#,
        account_id,
    )
    .fetch_optional(pool)
    .await
    .map_err(AppError::database_error)?;
    // `row` None → no such account; `row.stripe_customer_id` None → no Customer yet.
    Ok(row.and_then(|r| r.stripe_customer_id))
}

/// REVERSE lookup — the account a Stripe Customer belongs to, or `None` if no
/// account carries that customer id (PROV-B2-1, B3's webhook resolver). Exact
/// because `stripe_customer_id` is UNIQUE.
pub async fn account_by_customer(
    pool: &PgPool,
    customer_id: &str,
) -> Result<Option<Uuid>, AppError> {
    let row = sqlx::query!(
        r#"SELECT id FROM accounts WHERE stripe_customer_id = $1"#,
        customer_id,
    )
    .fetch_optional(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(row.map(|r| r.id))
}

/// Ensure the account has a Stripe Customer, creating one via `client` on first
/// checkout and persisting the id on `accounts.stripe_customer_id` (the link write,
/// PROV-B2-1). Idempotent + 1:1 (BQ-INV-9): a second call returns the SAME id
/// without creating another Customer, and a concurrent double-checkout reuses one
/// Customer via the CAS `UPDATE … WHERE stripe_customer_id IS NULL`.
///
/// Errors 404 if `account_id` names no account (never silently creates a dangling
/// Customer link).
pub async fn ensure_stripe_customer(
    pool: &PgPool,
    client: &StripeClient,
    account_id: Uuid,
) -> Result<String, AppError> {
    // Fast path: already linked (also the idempotent second-call path).
    if let Some(existing) = resolve_customer(pool, account_id).await? {
        return Ok(existing);
    }
    // No account row at all → 404 (don't create a Customer for a phantom account).
    let exists = sqlx::query_scalar!(
        r#"SELECT 1 as "one!" FROM accounts WHERE id = $1"#,
        account_id
    )
    .fetch_optional(pool)
    .await
    .map_err(AppError::database_error)?
    .is_some();
    if !exists {
        return Err(AppError::not_found("Account"));
    }

    // Create the Customer at Stripe, then CAS it in: only the caller that finds the
    // column still NULL wins; a concurrent winner's id is reused (our created
    // Customer is left unreferenced — acceptable, and the mock is stateless anyway).
    let created = client.create_customer(&account_id.to_string()).await?;
    let won = sqlx::query_scalar!(
        r#"UPDATE accounts
           SET stripe_customer_id = $1, updated_at = now()
           WHERE id = $2 AND stripe_customer_id IS NULL
           RETURNING stripe_customer_id"#,
        created,
        account_id,
    )
    .fetch_optional(pool)
    .await
    .map_err(AppError::database_error)?;

    match won {
        // We won the CAS: the column now holds our id.
        Some(Some(id)) => Ok(id),
        // Won but somehow NULL back (cannot happen given the SET) — fall back to the id.
        Some(None) => Ok(created),
        // A concurrent checkout won: reuse the persisted winner (1:1 preserved).
        None => match resolve_customer(pool, account_id).await? {
            Some(winner) => Ok(winner),
            // The account vanished between the existence check and now → 404.
            None => Err(AppError::not_found("Account")),
        },
    }
}

// ═══════════════════════════════════════════════════════════════════════════════════
// B1 — the usage-rollup fold + read queries (PROV-B1-1 / PROV-B1-2).
//
// Reader-only against the meter ledgers (INV-5): every statement below either SELECTs
// `compute_meter`/`storage_meter`, or writes ONLY `usage_rollup`. No meter row is ever
// mutated. All the fold SQL lives here (CODING_GUIDELINES §9); `rollup.rs` orchestrates.
// ═══════════════════════════════════════════════════════════════════════════════════

/// sqlx here has BOTH the `chrono` and `time` features, and the macro infers a
/// `timestamptz` BIND parameter as `time::OffsetDateTime` — so a chrono `DateTime<Utc>`
/// bind must be converted first (mirrors `mcp/pairing.rs`, which converts via the Unix
/// instant the two crates share). SELECT OUTPUTs use the `col as "col: DateTime<Utc>"`
/// override instead; this helper is only for BINDS.
fn to_offset(dt: DateTime<Utc>) -> sqlx::types::time::OffsetDateTime {
    sqlx::types::time::OffsetDateTime::from_unix_timestamp_nanos(
        dt.timestamp_nanos_opt().unwrap_or(0) as i128,
    )
    .unwrap_or(sqlx::types::time::OffsetDateTime::UNIX_EPOCH)
}

/// The outcome of folding ONE account's current period.
#[derive(Debug, Clone, Copy)]
pub struct FoldOutcome {
    /// The rollup row id (created on first fold, stable thereafter).
    pub id: Uuid,
    /// `true` iff this fold changed a billable figure (new compute recomputed, or the
    /// storage integral moved) — the signal to emit sync.
    pub changed: bool,
}

/// A rollup row that has UNREPORTED usage on ≥1 resource, with its per-resource REPORTED
/// watermark — the report step's input. The report pushes the DELTA `current − reported`
/// per resource (blind-audit F2: a summing meter totals deltas correctly, whereas
/// re-pushing the cumulative figure double-counts). Only accounts WITH a Stripe customer
/// appear (an account with none can't be metered — the JOIN is the has-customer filter).
#[derive(Debug, Clone)]
pub struct DirtyRollup {
    pub id: Uuid,
    pub account_id: Uuid,
    pub period_start: DateTime<Utc>,
    pub compute_core_hours: f64,
    pub gpu_hours: f64,
    pub storage_gb_months: f64,
    pub reported_compute_core_hours: f64,
    pub reported_gpu_hours: f64,
    pub reported_storage_gb_months: f64,
    pub last_meter_seen: Option<DateTime<Utc>>,
}

/// Distinct accounts with ANY metering activity relevant to `[period_start,
/// period_end)` — a compute row finishing before `period_end`, or a storage delta
/// created before `period_end` (storage needs the full prior history for its
/// integral). NULL `account_id` meter rows (scope-less / unresolvable — T5 DEC-1) are
/// excluded: B1 folds only rows with a resolvable account.
pub async fn accounts_with_activity(
    pool: &PgPool,
    _period_start: DateTime<Utc>,
    period_end: DateTime<Utc>,
) -> Result<Vec<Uuid>, AppError> {
    let rows = sqlx::query_scalar!(
        r#"
        SELECT DISTINCT account_id AS "account_id!"
        FROM (
            SELECT account_id FROM compute_meter
            WHERE account_id IS NOT NULL AND finished_at < $1
            UNION
            SELECT account_id FROM storage_meter
            WHERE account_id IS NOT NULL AND created_at < $1
        ) a
        "#,
        to_offset(period_end),
    )
    .fetch_all(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(rows)
}

/// Fold ONE account's current period into its `usage_rollup` row, EXACTLY-ONCE
/// (INV-1/INV-4). The whole read-compute-write runs in ONE transaction that LOCKS the
/// rollup row (`FOR UPDATE`), so two concurrent folds for the same account serialize:
/// the loser reads the advanced `last_meter_seen` and folds nothing (no double count,
/// TEST-9). Steps:
///  1. Ensure the period row exists (`INSERT … ON CONFLICT DO NOTHING`) + lock it.
///  2. Compute the INCREMENTAL compute sum over `finished_at ∈ [start,end)` AND
///     `> last_meter_seen`, split by `resource_class` (high-water mark, guard 2).
///  3. RECOMPUTE the storage GB-months integral over the FULL period delta history
///     (idempotent by construction, DEC-3).
///  4. `UPDATE` the row: ADD the compute increment, SET the recomputed storage,
///     advance the watermark, and CLEAR `reported_at` iff a figure changed.
pub async fn fold_account(
    pool: &PgPool,
    account_id: Uuid,
    period_start: DateTime<Utc>,
    period_end: DateTime<Utc>,
) -> Result<FoldOutcome, AppError> {
    let mut tx = pool.begin().await.map_err(AppError::database_error)?;

    // 1. Ensure the row exists, then lock it (serializes concurrent folds, TEST-9).
    sqlx::query!(
        r#"
        INSERT INTO usage_rollup (account_id, period_start, period_end)
        VALUES ($1, $2, $3)
        ON CONFLICT (account_id, period_start) DO NOTHING
        "#,
        account_id,
        to_offset(period_start),
        to_offset(period_end),
    )
    .execute(&mut *tx)
    .await
    .map_err(AppError::database_error)?;

    let current = sqlx::query!(
        r#"
        SELECT id, compute_core_hours, gpu_hours, storage_gb_months,
               last_meter_seen as "last_meter_seen?: DateTime<Utc>"
        FROM usage_rollup
        WHERE account_id = $1 AND period_start = $2
        FOR UPDATE
        "#,
        account_id,
        to_offset(period_start),
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(AppError::database_error)?;

    // 2. FULL-RECOMPUTE the compute sum over the WHOLE period, split by class (NOT a
    // high-water-marked incremental sum — a strict-`>` watermark over a non-unique
    // finished_at drops a boundary-tie / late-in-period row, an exactly-once
    // UNDERCOUNT, blind-audit F1). Recompute-SET is idempotent by construction and
    // picks up ties + late arrivals, exactly like the storage integral (DEC-3). A NULL
    // / non-"gpu" resource_class counts as CPU (→ core-hours); a "gpu" class →
    // gpu-hours. `last_meter_seen` = MAX(finished_at) counted, kept informational only.
    let compute = sqlx::query!(
        r#"
        SELECT
          COALESCE(SUM(CASE WHEN resource_class ILIKE '%gpu%' THEN 0 ELSE cpu_secs END), 0.0)
            AS "cpu_secs!",
          COALESCE(SUM(CASE WHEN resource_class ILIKE '%gpu%' THEN gpu_secs ELSE 0 END), 0.0)
            AS "gpu_secs!",
          MAX(finished_at) AS "new_hwm?: DateTime<Utc>"
        FROM compute_meter
        WHERE account_id = $1
          AND finished_at >= $2 AND finished_at < $3
        "#,
        account_id,
        to_offset(period_start),
        to_offset(period_end),
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(AppError::database_error)?;

    let recomputed_core = compute.cpu_secs / SECONDS_PER_HOUR;
    let recomputed_gpu = compute.gpu_secs / SECONDS_PER_HOUR;

    // 3. RECOMPUTE storage integral over the FULL period history (DEC-3). Opening
    // balance = signed sum of deltas BEFORE the period; in-period events in order.
    let opening: i64 = sqlx::query_scalar!(
        r#"SELECT COALESCE(SUM(delta_bytes), 0)::BIGINT AS "opening!"
           FROM storage_meter
           WHERE account_id = $1 AND created_at < $2"#,
        account_id,
        to_offset(period_start),
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(AppError::database_error)?;

    let events = sqlx::query!(
        r#"SELECT created_at as "created_at: DateTime<Utc>", delta_bytes FROM storage_meter
           WHERE account_id = $1 AND created_at >= $2 AND created_at < $3
           ORDER BY created_at, id"#,
        account_id,
        to_offset(period_start),
        to_offset(period_end),
    )
    .fetch_all(&mut *tx)
    .await
    .map_err(AppError::database_error)?;
    let event_pairs: Vec<(DateTime<Utc>, i64)> = events
        .iter()
        .map(|r| (r.created_at, r.delta_bytes))
        .collect();
    // Clamp to >= 0: a negative held-bytes integral (GC deltas exceeding ingest — a
    // data error / out-of-order ledger) is not a real negative bill (blind-audit F5).
    let new_storage = gb_months(opening, &event_pairs, period_start, period_end).max(0.0);

    // 4. Apply. Compute + storage are BOTH full-recompute SETs (idempotent). `changed`
    // iff any figure moved (drives the sync emit). The report step's own per-resource
    // reported_* watermark — NOT a reported_at flag here — governs re-reporting, so the
    // fold no longer touches reported_at (that removes the mark-reported race, F3).
    let new_core = recomputed_core;
    let new_gpu = recomputed_gpu;
    let changed = new_core != current.compute_core_hours
        || new_gpu != current.gpu_hours
        || new_storage != current.storage_gb_months;
    // `last_meter_seen` is informational (MAX finished_at counted); keep the old value
    // when the period has no compute rows this fold.
    let new_hwm = compute.new_hwm.or(current.last_meter_seen);

    sqlx::query!(
        r#"
        UPDATE usage_rollup
        SET compute_core_hours = $1,
            gpu_hours          = $2,
            storage_gb_months  = $3,
            last_meter_seen    = $4,
            updated_at         = now()
        WHERE id = $5
        "#,
        new_core,
        new_gpu,
        new_storage,
        new_hwm.map(to_offset),
        current.id,
    )
    .execute(&mut *tx)
    .await
    .map_err(AppError::database_error)?;

    tx.commit().await.map_err(AppError::database_error)?;
    Ok(FoldOutcome {
        id: current.id,
        changed,
    })
}

/// The account's rollup rows, newest period first, paginated (PROV-B1-2). Account-
/// scoped by the caller passing the resolved `ActiveAccount.account_id` (INV-2 — a
/// cross-account read returns THAT account's rows only, so a foreign account yields an
/// empty page, never another tenant's usage). Returns `(rows, total)`.
pub async fn list_usage(
    pool: &PgPool,
    account_id: Uuid,
    page: i32,
    per_page: i32,
) -> Result<(Vec<UsageRollupRow>, i64), AppError> {
    let offset = (page - 1).max(0) as i64 * per_page as i64;
    let rows = sqlx::query_as!(
        UsageRollupRow,
        r#"
        SELECT id, account_id,
               period_start as "period_start: DateTime<Utc>",
               period_end as "period_end: DateTime<Utc>",
               compute_core_hours, gpu_hours, storage_gb_months, egress_gb,
               last_meter_seen as "last_meter_seen?: DateTime<Utc>",
               reported_at as "reported_at?: DateTime<Utc>",
               updated_at as "updated_at: DateTime<Utc>"
        FROM usage_rollup
        WHERE account_id = $1
        ORDER BY period_start DESC
        LIMIT $2 OFFSET $3
        "#,
        account_id,
        per_page as i64,
        offset,
    )
    .fetch_all(pool)
    .await
    .map_err(AppError::database_error)?;

    let total = sqlx::query_scalar!(
        r#"SELECT COUNT(*) AS "count!" FROM usage_rollup WHERE account_id = $1"#,
        account_id,
    )
    .fetch_one(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok((rows, total))
}

/// Every rollup row with UNREPORTED usage on ≥1 resource (`current > reported_*`) whose
/// account HAS a Stripe customer — the report step's input. Dirtiness is a per-resource
/// VALUE comparison (not a `reported_at` flag), so a fold that advances usage after a
/// report is picked up as the remaining delta on the next scan (no lost update, F3). The
/// JOIN is the has-customer filter (an account with none can't be metered).
pub async fn dirty_with_customer(pool: &PgPool) -> Result<Vec<DirtyRollup>, AppError> {
    let rows = sqlx::query!(
        r#"
        SELECT r.id, r.account_id,
               r.period_start as "period_start: DateTime<Utc>",
               r.compute_core_hours, r.gpu_hours, r.storage_gb_months,
               r.reported_compute_core_hours, r.reported_gpu_hours, r.reported_storage_gb_months,
               r.last_meter_seen as "last_meter_seen?: DateTime<Utc>"
        FROM usage_rollup r
        JOIN accounts a ON a.id = r.account_id
        WHERE a.stripe_customer_id IS NOT NULL
          AND (r.compute_core_hours   > r.reported_compute_core_hours
            OR r.gpu_hours            > r.reported_gpu_hours
            OR r.storage_gb_months    > r.reported_storage_gb_months)
        ORDER BY r.account_id, r.period_start
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(rows
        .into_iter()
        .map(|r| DirtyRollup {
            id: r.id,
            account_id: r.account_id,
            period_start: r.period_start,
            compute_core_hours: r.compute_core_hours,
            gpu_hours: r.gpu_hours,
            storage_gb_months: r.storage_gb_months,
            reported_compute_core_hours: r.reported_compute_core_hours,
            reported_gpu_hours: r.reported_gpu_hours,
            reported_storage_gb_months: r.reported_storage_gb_months,
            last_meter_seen: r.last_meter_seen,
        })
        .collect())
}

// ═══════════════════════════════════════════════════════════════════════════════════
// B3 — the webhook idempotency + dunning state writes (PROV-B3-1 / PROV-B3-2).
//
// The reconciliation boundary's DB layer: the dedupe check + the account state UPDATE + the
// dedupe MARK all run in ONE transaction (DEC-5), the mark AFTER dispatch, so a crash
// mid-flight re-delivers cleanly and a redelivered event is a no-op (INV-3). All webhook SQL
// lives here (§9); `webhook.rs` extracts the event fields + computes the pure `Transition`
// (`dunning::next_state`) and calls `process_webhook`.
// ═══════════════════════════════════════════════════════════════════════════════════

/// The outcome of ingesting one webhook event.
#[derive(Debug, Clone, Copy)]
pub struct WebhookOutcome {
    /// The event id was already recorded — a redelivery; nothing was applied (INV-3).
    pub duplicate: bool,
    /// The account the event resolved to (via the reverse customer link), if any.
    pub account_id: Option<Uuid>,
    /// A billable state figure changed (the signal to emit the sync notify).
    pub state_changed: bool,
}

/// Ingest one signature-verified webhook event idempotently (**PROV-B3-2**). In ONE txn:
///  1. **CLAIM** the `event_id` (`INSERT … ON CONFLICT DO NOTHING`) — a 0-row insert means it
///     was already processed → a no-op 200 (INV-3). Claiming FIRST, inside the same txn as the
///     state change, is BOTH crash-safe (a crash before commit rolls the claim AND the apply
///     back together → Stripe redelivers → reprocessed) AND concurrency-safe (a concurrent
///     duplicate BLOCKS on the `event_id` unique constraint, then sees the row and no-ops) —
///     it closes the SELECT-then-mark TOCTOU (DEC-5 CORRECTION, §4 `ON CONFLICT` idiom);
///  2. resolve the account from the Stripe `customer` (reverse link, PROV-B2-1) if present;
///  3. apply the pure `Transition` to that account's billing-state columns.
///
/// Because the claim + apply commit atomically, a duplicate can NEVER re-apply — so even the
/// clock-dependent `GraceAction::SetFromNow` arm cannot re-advance `grace_until` on a
/// redelivery. An event whose customer resolves to no account (or an unhandled type with a
/// `None` transition) is still CLAIMED so a redelivery is a no-op, but changes no state.
pub async fn process_webhook(
    pool: &PgPool,
    event_id: &str,
    event_type: &str,
    customer: Option<&str>,
    transition: Option<&Transition>,
    grace_days: i32,
) -> Result<WebhookOutcome, AppError> {
    let mut tx = pool.begin().await.map_err(AppError::database_error)?;

    // 1. CLAIM the event id first (atomic dedupe). 0 rows ⇒ already processed ⇒ no-op (INV-3).
    let claimed = sqlx::query!(
        r#"INSERT INTO billing_webhook_events (event_id, event_type)
           VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING"#,
        event_id,
        event_type,
    )
    .execute(&mut *tx)
    .await
    .map_err(AppError::database_error)?
    .rows_affected();
    if claimed == 0 {
        tx.commit().await.map_err(AppError::database_error)?;
        return Ok(WebhookOutcome {
            duplicate: true,
            account_id: None,
            state_changed: false,
        });
    }

    // 2. Resolve the acting account from the event's `customer` (reverse link).
    let account_id = match customer {
        Some(c) => sqlx::query_scalar!(
            r#"SELECT id FROM accounts WHERE stripe_customer_id = $1"#,
            c,
        )
        .fetch_optional(&mut *tx)
        .await
        .map_err(AppError::database_error)?,
        None => None,
    };

    // 3. Apply the transition (only when both an account AND a handled transition exist).
    let mut state_changed = false;
    if let (Some(aid), Some(t)) = (account_id, transition) {
        state_changed = apply_transition(&mut tx, aid, t, grace_days).await?;
    }

    tx.commit().await.map_err(AppError::database_error)?;
    Ok(WebhookOutcome {
        duplicate: false,
        account_id,
        state_changed,
    })
}

/// Apply a pure `Transition` to one account's billing-state columns inside `tx` (ITEM-5).
/// Locks the row (`FOR UPDATE`) so concurrent webhooks for the same account serialize; each
/// arm derives the TARGET value (never increments), so re-application is idempotent (INV-3).
/// Returns `true` iff any of `subscription_status`/`plan_id`/`grace_until` moved. Performs NO
/// row deletion on any tenant table — a cancel is a state revert only (INV-1).
async fn apply_transition(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    account_id: Uuid,
    transition: &Transition,
    grace_days: i32,
) -> Result<bool, AppError> {
    let current = sqlx::query!(
        r#"SELECT plan_id, subscription_status, plan_manually_set,
                  grace_until as "grace_until?: DateTime<Utc>"
           FROM accounts WHERE id = $1 FOR UPDATE"#,
        account_id,
    )
    .fetch_one(&mut **tx)
    .await
    .map_err(AppError::database_error)?;

    let new_status = transition.status.clone();
    // Reconciliation crux (#38, DEC-6): while an admin plan-override marker is set, a webhook
    // NEVER overwrites `plan_id` — the admin comp wins until explicitly cleared. The marker is
    // read HERE, inside the same `FOR UPDATE` lock as the transition, so there is no race with a
    // concurrent override write. `subscription_status`/`grace_until` STILL update below (the
    // Stripe lifecycle is tracked, so a real cancel still derives a billing suspension). With
    // `plan_manually_set = false` (the default) this is byte-identical to the pre-#38 behavior.
    let new_plan = if current.plan_manually_set {
        current.plan_id.clone()
    } else {
        match &transition.plan {
            PlanChange::Keep => current.plan_id.clone(),
            PlanChange::Set(p) => p.clone(),
            PlanChange::Free => "free".to_string(),
        }
    };
    let new_grace: Option<DateTime<Utc>> = match transition.grace {
        GraceAction::Keep => current.grace_until,
        GraceAction::Clear => None,
        GraceAction::SetFromNow => Some(Utc::now() + Duration::days(grace_days as i64)),
    };

    let changed = new_status != current.subscription_status
        || new_plan != current.plan_id
        || new_grace != current.grace_until;

    sqlx::query!(
        r#"UPDATE accounts
           SET subscription_status = $1, plan_id = $2, grace_until = $3, updated_at = now()
           WHERE id = $4"#,
        new_status,
        new_plan,
        new_grace.map(to_offset),
        account_id,
    )
    .execute(&mut **tx)
    .await
    .map_err(AppError::database_error)?;

    Ok(changed)
}

/// Delete `billing_webhook_events` rows older than `older_than_days` (DEC-7 retention — the
/// dedupe table's bounded prune, §4). Returns the number of rows removed. Stripe never
/// retries beyond ~3 days, so a 90d default leaves a generous safety margin.
pub async fn prune_webhook_events(pool: &PgPool, older_than_days: i64) -> Result<u64, AppError> {
    let cutoff = Utc::now() - Duration::days(older_than_days);
    let res = sqlx::query!(
        r#"DELETE FROM billing_webhook_events WHERE processed_at < $1"#,
        to_offset(cutoff),
    )
    .execute(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(res.rows_affected())
}

/// The configured dunning grace window in days (ITEM-9 / DEC-6). Read-at-use from the
/// `billing_settings` singleton; falls back to the default 14 if the row is somehow absent.
pub async fn grace_period_days(pool: &PgPool) -> Result<i32, AppError> {
    let v = sqlx::query_scalar!(
        r#"SELECT grace_period_days FROM billing_settings WHERE singleton = true"#,
    )
    .fetch_optional(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(v.unwrap_or(14))
}

// `set_grace_period_days` (the ITEM-9/DEC-6 single-field writer) was DELETED by #295.
// #41 replaced `put_settings`'s write path with `update_billing_settings` below — a partial,
// bounds-validated, `updated_by`-stamping upsert — and dropped the old setter's import,
// leaving a `pub` item with no caller that `dead_code` cannot see in a library crate.

/// The full `billing_settings` singleton row (#41 admin-settings-coverage). Read-at-use; the
/// seeded row always exists (a fresh migrate inserts it). Callers that only need one field
/// (e.g. the dunning path's `grace_period_days`) keep their narrower reader.
pub async fn get_billing_settings(pool: &PgPool) -> Result<BillingSettings, AppError> {
    sqlx::query_as!(
        BillingSettings,
        r#"SELECT grace_period_days,
                  overage_cents_per_core_hour,
                  overage_cents_per_gb_month,
                  webhook_event_retention_days,
                  webhook_signature_tolerance_secs,
                  updated_by as "updated_by: Uuid"
           FROM billing_settings WHERE singleton = true"#,
    )
    .fetch_one(pool)
    .await
    .map_err(AppError::database_error)
}

/// Persist a PARTIAL settings update (#41), stamping the audit `updated_by` (INV-4) +
/// `updated_at`. Each field is applied via SQL `COALESCE($n, col)` so an absent field is left
/// unchanged AND the write is per-field ATOMIC — two concurrent PUTs that set DIFFERENT fields
/// both land (no lost update; FIX_ROUND-1). The caller MUST have bounds-validated the merged
/// candidate (`BillingSettings::validate`) for the typed 422; the DB CHECKs are the atomic
/// backstop. Returns the stored row.
pub async fn update_billing_settings(
    pool: &PgPool,
    req: &UpdateBillingSettingsRequest,
    updated_by: Uuid,
) -> Result<BillingSettings, AppError> {
    sqlx::query_as!(
        BillingSettings,
        r#"UPDATE billing_settings
           SET grace_period_days = COALESCE($1, grace_period_days),
               overage_cents_per_core_hour = COALESCE($2, overage_cents_per_core_hour),
               overage_cents_per_gb_month = COALESCE($3, overage_cents_per_gb_month),
               webhook_event_retention_days = COALESCE($4, webhook_event_retention_days),
               webhook_signature_tolerance_secs = COALESCE($5, webhook_signature_tolerance_secs),
               updated_by = $6,
               updated_at = now()
           WHERE singleton = true
           RETURNING grace_period_days,
                     overage_cents_per_core_hour,
                     overage_cents_per_gb_month,
                     webhook_event_retention_days,
                     webhook_signature_tolerance_secs,
                     updated_by as "updated_by: Uuid""#,
        req.grace_period_days,
        req.overage_cents_per_core_hour,
        req.overage_cents_per_gb_month,
        req.webhook_event_retention_days,
        req.webhook_signature_tolerance_secs,
        updated_by,
    )
    .fetch_one(pool)
    .await
    .map_err(AppError::database_error)
}

/// The `usage_rollup.reported_*` watermark column for a resource event-name. Returns
/// `None` for an unknown resource (the caller then skips it).
fn reported_column(resource: &str) -> Option<&'static str> {
    match resource {
        "compute_core_hours" => Some("reported_compute_core_hours"),
        "gpu_hours" => Some("reported_gpu_hours"),
        "storage_gb_months" => Some("reported_storage_gb_months"),
        _ => None,
    }
}

/// Advance ONE resource's reported watermark to `value` after a SUCCESSFUL push (the
/// exactly-once report guard, guard 3). Idempotent + monotone: `WHERE reported_<res> <
/// value` so a re-run or a stale push never regresses the watermark. Also stamps
/// `reported_at`/`stripe_usage_ref` for audit. A no-op if `resource` is unknown.
pub async fn advance_reported(
    pool: &PgPool,
    id: Uuid,
    resource: &str,
    value: f64,
    identifier: &str,
) -> Result<(), AppError> {
    let Some(col) = reported_column(resource) else {
        return Ok(());
    };
    // `col` is a fixed literal from the match above (never user input), so the format
    // is injection-safe; the value + id are bound parameters.
    let sql = format!(
        "UPDATE usage_rollup \
         SET {col} = $2, reported_at = now(), stripe_usage_ref = $3, updated_at = now() \
         WHERE id = $1 AND {col} < $2"
    );
    sqlx::query(&sql)
        .bind(id)
        .bind(value)
        .bind(identifier)
        .execute(pool)
        .await
        .map_err(AppError::database_error)?;
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════════════
// B4 — the quota reads + the spend-cap / alert-state writes (PROV-B4-1 / PROV-B4-2).
//
// `check_quota` (quota.rs) is a pure READER (DEC-7 / BQ-INV-2): the reads below issue only
// SELECTs against `accounts` + `usage_rollup` + `account_spend_cap`. The ONLY writes B4
// ever makes are the spend-cap upsert (ITEM-2, the cap PUT) + the alert-state upsert
// (ITEM-4, the alert loop) — never the check. All the SQL lives here (§9); `quota.rs` /
// `alerts.rs` orchestrate.
// ═══════════════════════════════════════════════════════════════════════════════════

/// The account's `(plan_id, subscription_status)` — the plan lookup key (PROV-B2-2) + the
/// effective-billing-state source (PROV-B3-1) `check_quota` reads. `None` for a nonexistent
/// account (the check then fails closed). Keyed on `accounts.id` (INV-4).
pub async fn account_billing_context(
    pool: &PgPool,
    account_id: Uuid,
) -> Result<Option<(String, String)>, AppError> {
    let row = sqlx::query!(
        r#"SELECT plan_id, subscription_status FROM accounts WHERE id = $1"#,
        account_id,
    )
    .fetch_optional(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(row.map(|r| (r.plan_id, r.subscription_status)))
}

/// The account's ADMIN-SET suspension flag (#37) — a pure SELECT `check_quota` OR-s into its
/// `suspended` gate ALONGSIDE the derived `is_suspended(subscription_status)` (DEC-3/DEC-12). A
/// missing account reads `false` (the plan/billing-context read fails closed separately). A
/// separate reader (not folded into `account_billing_context`) so that function's other two
/// callers stay byte-unchanged. `false` (every existing account) leaves the verdict identical.
pub async fn admin_suspended(pool: &PgPool, account_id: Uuid) -> Result<bool, AppError> {
    let v = sqlx::query_scalar!(
        r#"SELECT admin_suspended FROM accounts WHERE id = $1"#,
        account_id,
    )
    .fetch_optional(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(v.unwrap_or(false))
}

/// An account's plan + manual-override state (#38) — the shape the admin plan route surfaces.
#[derive(Debug, Clone, PartialEq)]
pub struct PlanOverrideState {
    pub account_id: Uuid,
    pub plan_id: String,
    pub plan_manually_set: bool,
    pub plan_override_at: Option<DateTime<Utc>>,
    pub plan_override_by: Option<Uuid>,
}

/// Read an account's plan + manual-override state (#38) — for the admin plan route response.
/// `None` for a nonexistent account (the `AdminBillingScope` extractor already proved existence,
/// so `None` is defensive → 404, never 500).
pub async fn account_plan_state(
    pool: &PgPool,
    account_id: Uuid,
) -> Result<Option<PlanOverrideState>, AppError> {
    let row = sqlx::query!(
        r#"SELECT plan_id, plan_manually_set,
                  plan_override_at as "plan_override_at?: DateTime<Utc>",
                  plan_override_by as "plan_override_by?: Uuid"
           FROM accounts WHERE id = $1"#,
        account_id,
    )
    .fetch_optional(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(row.map(|r| PlanOverrideState {
        account_id,
        plan_id: r.plan_id,
        plan_manually_set: r.plan_manually_set,
        plan_override_at: r.plan_override_at,
        plan_override_by: r.plan_override_by,
    }))
}

/// Set an admin plan override (#38, DEC-6/DEC-7): write `plan_id` DIRECTLY (NO Stripe) + mark
/// `plan_manually_set = true` (+ audit `plan_override_at`/`plan_override_by`). While the marker is
/// set, `apply_transition` never overwrites `plan_id` (a later webhook cannot clobber the comp).
/// The caller MUST have validated `plan_id` against the catalog (an unknown plan fails `check_quota`
/// closed). Each call derives the target (never increments) — re-setting is idempotent.
pub async fn set_account_plan_override(
    pool: &PgPool,
    account_id: Uuid,
    plan_id: &str,
    by: Uuid,
) -> Result<(), AppError> {
    sqlx::query!(
        r#"UPDATE accounts
           SET plan_id = $1, plan_manually_set = true,
               plan_override_at = now(), plan_override_by = $2, updated_at = now()
           WHERE id = $3"#,
        plan_id,
        by,
        account_id,
    )
    .execute(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(())
}

/// Clear an admin plan override (#38, DEC-7): clear the `plan_manually_set` marker + its audit
/// columns, handing plan control back to Stripe (the NEXT webhook reconciles `plan_id`). Leaves
/// the current `plan_id` AS-IS — clearing releases future webhooks, it does not itself revert the
/// plan. Idempotent (clearing an unset override is a harmless no-op re-write).
pub async fn clear_account_plan_override(
    pool: &PgPool,
    account_id: Uuid,
) -> Result<(), AppError> {
    sqlx::query!(
        r#"UPDATE accounts
           SET plan_manually_set = false, plan_override_at = NULL, plan_override_by = NULL,
               updated_at = now()
           WHERE id = $1"#,
        account_id,
    )
    .execute(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(())
}

/// The account's full subscription state — `(plan_id, subscription_status, grace_until)` —
/// for the ADMIN read-any-account surface (`GET /api/admin/accounts/{id}/billing`, #36).
/// `None` for a nonexistent account (the handler then 404s — though the `AdminBillingScope`
/// extractor already proved the account exists before dispatch, so `None` is defensive).
/// Keyed on `accounts.id` (INV-5, path-scoped). Mirrors `account_billing_context` but also
/// returns the dunning `grace_until` deadline B3 writes on `invoice.payment_failed`.
pub async fn account_subscription_state(
    pool: &PgPool,
    account_id: Uuid,
) -> Result<Option<(String, String, Option<DateTime<Utc>>)>, AppError> {
    let row = sqlx::query!(
        r#"SELECT plan_id, subscription_status,
                  grace_until as "grace_until?: DateTime<Utc>"
           FROM accounts WHERE id = $1"#,
        account_id,
    )
    .fetch_optional(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(row.map(|r| (r.plan_id, r.subscription_status, r.grace_until)))
}

/// The current-period billable usage figures for an account, ZERO when no `usage_rollup`
/// row exists yet (PROV-B1-1). Reads the ROLLUP (the incrementally-maintained current-period
/// row), never re-sums the raw meters (DEC-8 / BQ-INV-2). The current period is the calendar
/// UTC month (mirrors B1's `current_period`).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct CurrentUsage {
    pub compute_core_hours: f64,
    pub gpu_hours: f64,
    pub storage_gb_months: f64,
}

/// Read the account's `usage_rollup` figures for an EXPLICIT `period_start` (PROV-B1-1).
/// Returns all-zero when no row exists. The alert sweep passes the period it read ONCE at the
/// top of the cycle, so the usage read and the alert-state write can never straddle a
/// month-boundary clock re-read (blind-audit F2).
pub async fn period_usage(
    pool: &PgPool,
    account_id: Uuid,
    period_start: DateTime<Utc>,
) -> Result<CurrentUsage, AppError> {
    let row = sqlx::query!(
        r#"SELECT compute_core_hours, gpu_hours, storage_gb_months
           FROM usage_rollup WHERE account_id = $1 AND period_start = $2"#,
        account_id,
        to_offset(period_start),
    )
    .fetch_optional(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(row
        .map(|r| CurrentUsage {
            compute_core_hours: r.compute_core_hours,
            gpu_hours: r.gpu_hours,
            storage_gb_months: r.storage_gb_months,
        })
        .unwrap_or_default())
}

/// Read the account's CURRENT-period `usage_rollup` figures (PROV-B1-1) — the `check_quota` /
/// quota-read path, which resolves the current calendar-month period itself.
pub async fn current_period_usage(
    pool: &PgPool,
    account_id: Uuid,
) -> Result<CurrentUsage, AppError> {
    let (period_start, _period_end) = current_period(Utc::now());
    period_usage(pool, account_id, period_start).await
}

/// The opt-in per-account spend cap in cents (ITEM-2), or `None` when no cap row exists or
/// the cap is NULL (the §4.3 opt-in default = no cap). Keyed on `accounts.id` (INV-4).
pub async fn spend_cap(pool: &PgPool, account_id: Uuid) -> Result<Option<i64>, AppError> {
    let row = sqlx::query!(
        r#"SELECT overage_cap_cents FROM account_spend_cap WHERE account_id = $1"#,
        account_id,
    )
    .fetch_optional(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(row.and_then(|r| r.overage_cap_cents))
}

/// Set (or, with `None`, clear) the account's opt-in spend cap (ITEM-2). Upsert on the
/// `account_id` PK. The caller MUST have bounds-validated `cents ≥ 0`; the DB CHECK backs it.
pub async fn set_spend_cap(
    pool: &PgPool,
    account_id: Uuid,
    cents: Option<i64>,
) -> Result<(), AppError> {
    sqlx::query!(
        r#"INSERT INTO account_spend_cap (account_id, overage_cap_cents, updated_at)
           VALUES ($1, $2, now())
           ON CONFLICT (account_id)
           DO UPDATE SET overage_cap_cents = $2, updated_at = now()"#,
        account_id,
        cents,
    )
    .execute(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(())
}

/// Distinct accounts with a `usage_rollup` row in `period_start` — the alert loop's per-period
/// worklist (ITEM-4). Only accounts with metered activity this period can cross a rung.
pub async fn accounts_with_current_rollup(
    pool: &PgPool,
    period_start: DateTime<Utc>,
) -> Result<Vec<Uuid>, AppError> {
    let rows = sqlx::query_scalar!(
        r#"SELECT account_id AS "account_id!" FROM usage_rollup WHERE period_start = $1"#,
        to_offset(period_start),
    )
    .fetch_all(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(rows)
}

/// The current-period alert levels `(compute, storage)` already fired for an account (ITEM-5,
/// the quota read). `0` when no rung has fired for that resource this period. Reads
/// `usage_alert_state` for the current calendar-month period (mirrors `current_period_usage`).
pub async fn current_alert_levels(pool: &PgPool, account_id: Uuid) -> Result<(i16, i16), AppError> {
    let (period_start, _period_end) = current_period(Utc::now());
    let rows = sqlx::query!(
        r#"SELECT resource, level_notified
           FROM usage_alert_state WHERE account_id = $1 AND period_start = $2"#,
        account_id,
        to_offset(period_start),
    )
    .fetch_all(pool)
    .await
    .map_err(AppError::database_error)?;
    let mut compute = 0i16;
    let mut storage = 0i16;
    for r in rows {
        match r.resource.as_str() {
            "compute" => compute = r.level_notified,
            "storage" => storage = r.level_notified,
            _ => {}
        }
    }
    Ok((compute, storage))
}

/// Advance the fire-once alert ladder for `(account, period, resource)` to `rung` — the
/// dedup write (ITEM-4). Monotone upsert: a fresh row inserts at `rung`; an existing row
/// advances ONLY when its `level_notified < rung` (the `WHERE` guard). Returns `Some(rung)`
/// when it newly ADVANCED (the caller then emits an alert) and `None` when the rung was
/// already fired (a re-run over the same usage emits nothing). `resource` is a short literal
/// (`compute`/`storage`), never user input.
pub async fn advance_alert_level(
    pool: &PgPool,
    account_id: Uuid,
    period_start: DateTime<Utc>,
    resource: &str,
    rung: i16,
) -> Result<Option<i16>, AppError> {
    let row = sqlx::query_scalar!(
        r#"INSERT INTO usage_alert_state (account_id, period_start, resource, level_notified, notified_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (account_id, period_start, resource)
           DO UPDATE SET level_notified = $4, notified_at = now()
           WHERE usage_alert_state.level_notified < $4
           RETURNING level_notified"#,
        account_id,
        to_offset(period_start),
        resource,
        rung,
    )
    .fetch_optional(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(row)
}

// ─────────────────────────── #39 credit ledger + comp/premium override ───────────────────────────
//
// The admin-granted OVERRIDE layer `check_quota` consults BEFORE the plan-derived verdict (design
// `docs/design/admin-credits-override.md`). All reads here are pure SELECTs (the engine stays a
// reader, BQ-INV-2); the writes are the admin grant/revoke/premium mutations, called ONLY from the
// gated `billing/admin.rs` handlers — never from `check_quota`.

/// One row of the append-only `credit_grants` ledger (#39). Carries the full audit trail
/// (`granted_by` / `reason` / `created_at`) plus the revoke marker (`revoked_at` / `revoked_by`);
/// a row is NEVER hard-deleted or amount-mutated (DEC-6). `amount_cents` is a positive
/// overage-admission budget in CENTS (DEC-1).
#[derive(Debug, Clone)]
pub struct CreditGrant {
    pub id: Uuid,
    pub account_id: Uuid,
    pub amount_cents: i64,
    pub reason: String,
    pub granted_by: Uuid,
    pub expires_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub revoked_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
}

/// The per-account comp/premium override (#39) — the `account_quota_override` singleton. `premium`
/// = unlimited plan allowance (INV-3). Defaults to NOT-premium when no row exists (INV-5).
#[derive(Debug, Clone, Default)]
pub struct QuotaOverride {
    pub premium: bool,
    pub reason: Option<String>,
    pub set_by: Option<Uuid>,
    pub updated_at: Option<DateTime<Utc>>,
}

/// The account's EFFECTIVE credit balance in cents (#39 / INV-1, INV-7): the SUM of every grant
/// that is NOT revoked and NOT expired. `0` when the account has no active grant. A SUM of
/// `amount_cents > 0` rows, so it can never be negative (DEC-7 underflow guard). This is the
/// overage-admission budget `check_quota` reads (a pure SELECT).
pub async fn credit_balance(pool: &PgPool, account_id: Uuid) -> Result<i64, AppError> {
    let bal = sqlx::query_scalar!(
        r#"SELECT COALESCE(SUM(amount_cents), 0)::bigint AS "balance!"
           FROM credit_grants
           WHERE account_id = $1
             AND revoked_at IS NULL
             AND (expires_at IS NULL OR expires_at > now())"#,
        account_id,
    )
    .fetch_one(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(bal)
}

/// A per-account billing PROJECTION for the admin user-list column (#43): the comp/premium
/// allowance override, the plan/tier id, and the effective credit balance. A pure read composed
/// from `accounts` + `account_quota_override` + the active-grant sum.
#[derive(Debug, Clone)]
pub struct AccountBillingSummary {
    /// `account_quota_override.premium` (default `false` when no override row).
    pub premium: bool,
    /// `accounts.plan_id` (the catalog/tier key; default `free`).
    pub plan_id: String,
    /// The effective credit balance in cents — the SAME active-grant sum as [`credit_balance`].
    pub credit_balance_cents: i64,
}

/// Batched billing summaries for a SET of accounts in ONE query (`= ANY($1)`), keyed by account id
/// — the read the admin user-list projection uses to attach per-user billing without an N+1
/// fan-out. Accounts drives a LEFT JOIN, so an account with NO override row / NO active grant still
/// appears with the defaults `premium=false`, `credit_balance_cents=0`, `plan_id` = its stored plan.
/// The active-grant predicate is IDENTICAL to [`credit_balance`] (non-revoked, non-expired), so the
/// balance here equals the admission engine's budget (INV-2). An account id not found (deleted) is
/// simply absent from the map.
pub async fn account_billing_summaries(
    pool: &PgPool,
    account_ids: &[Uuid],
) -> Result<std::collections::HashMap<Uuid, AccountBillingSummary>, AppError> {
    if account_ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let rows = sqlx::query!(
        r#"SELECT a.id                          AS "account_id!",
                  a.plan_id                     AS "plan_id!",
                  COALESCE(qo.premium, false)   AS "premium!",
                  COALESCE(g.balance, 0)::bigint AS "credit_balance_cents!"
           FROM accounts a
           LEFT JOIN account_quota_override qo ON qo.account_id = a.id
           LEFT JOIN (
               SELECT account_id, SUM(amount_cents) AS balance
               FROM credit_grants
               WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
               GROUP BY account_id
           ) g ON g.account_id = a.id
           WHERE a.id = ANY($1)"#,
        account_ids,
    )
    .fetch_all(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(rows
        .into_iter()
        .map(|r| {
            (
                r.account_id,
                AccountBillingSummary {
                    premium: r.premium,
                    plan_id: r.plan_id,
                    credit_balance_cents: r.credit_balance_cents,
                },
            )
        })
        .collect())
}

/// The FULL `credit_grants` ledger for an account, newest first — INCLUDING revoked + expired rows
/// (the audit view, INV-4). The admin `GET …/credits` binds this alongside `credit_balance`.
pub async fn list_credit_grants(
    pool: &PgPool,
    account_id: Uuid,
) -> Result<Vec<CreditGrant>, AppError> {
    let rows = sqlx::query!(
        r#"SELECT id, account_id, amount_cents, reason, granted_by,
                  expires_at AS "expires_at?: DateTime<Utc>",
                  revoked_at AS "revoked_at?: DateTime<Utc>",
                  revoked_by AS "revoked_by?: Uuid",
                  created_at AS "created_at: DateTime<Utc>"
           FROM credit_grants
           WHERE account_id = $1
           ORDER BY created_at DESC, id"#,
        account_id,
    )
    .fetch_all(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(rows
        .into_iter()
        .map(|r| CreditGrant {
            id: r.id,
            account_id: r.account_id,
            amount_cents: r.amount_cents,
            reason: r.reason,
            granted_by: r.granted_by,
            expires_at: r.expires_at,
            revoked_at: r.revoked_at,
            revoked_by: r.revoked_by,
            created_at: r.created_at,
        })
        .collect())
}

/// Insert ONE credit grant and return the persisted row (#39, ITEM-2). The caller MUST have
/// validated `amount_cents > 0` + a non-empty `reason` (the request-validate + the DB CHECK both
/// back it). `expires_at = None` ⇒ never expires. Append-only: this is the only way a grant is
/// created (re-granting is a new row, DEC-6).
pub async fn insert_credit_grant(
    pool: &PgPool,
    account_id: Uuid,
    amount_cents: i64,
    reason: &str,
    granted_by: Uuid,
    expires_at: Option<DateTime<Utc>>,
) -> Result<CreditGrant, AppError> {
    let r = sqlx::query!(
        r#"INSERT INTO credit_grants
               (account_id, amount_cents, reason, granted_by, expires_at)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, account_id, amount_cents, reason, granted_by,
                     expires_at AS "expires_at?: DateTime<Utc>",
                     revoked_at AS "revoked_at?: DateTime<Utc>",
                     revoked_by AS "revoked_by?: Uuid",
                     created_at AS "created_at: DateTime<Utc>""#,
        account_id,
        amount_cents,
        reason,
        granted_by,
        expires_at.map(to_offset),
    )
    .fetch_one(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(CreditGrant {
        id: r.id,
        account_id: r.account_id,
        amount_cents: r.amount_cents,
        reason: r.reason,
        granted_by: r.granted_by,
        expires_at: r.expires_at,
        revoked_at: r.revoked_at,
        revoked_by: r.revoked_by,
        created_at: r.created_at,
    })
}

/// Fetch ONE grant by id (#39) — used by the revoke handler to 404 a nonexistent/foreign grant
/// before acting. Returns `None` when no such grant exists.
pub async fn get_credit_grant(
    pool: &PgPool,
    grant_id: Uuid,
) -> Result<Option<CreditGrant>, AppError> {
    let row = sqlx::query!(
        r#"SELECT id, account_id, amount_cents, reason, granted_by,
                  expires_at AS "expires_at?: DateTime<Utc>",
                  revoked_at AS "revoked_at?: DateTime<Utc>",
                  revoked_by AS "revoked_by?: Uuid",
                  created_at AS "created_at: DateTime<Utc>"
           FROM credit_grants WHERE id = $1"#,
        grant_id,
    )
    .fetch_optional(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(row.map(|r| CreditGrant {
        id: r.id,
        account_id: r.account_id,
        amount_cents: r.amount_cents,
        reason: r.reason,
        granted_by: r.granted_by,
        expires_at: r.expires_at,
        revoked_at: r.revoked_at,
        revoked_by: r.revoked_by,
        created_at: r.created_at,
    }))
}

/// Revoke a grant — stamp `revoked_at = now()` + `revoked_by` (#39, DEC-6). Append-only: it
/// NEVER deletes the row. Scoped to `account_id` (a grant can only be revoked through its own
/// account's admin path) AND guarded on `revoked_at IS NULL`, so a re-revoke or a foreign-account
/// revoke changes NOTHING (returns `false`) — idempotent, no double-effect (INV-7). Returns
/// `true` iff this call newly revoked it.
pub async fn revoke_credit_grant(
    pool: &PgPool,
    grant_id: Uuid,
    account_id: Uuid,
    revoked_by: Uuid,
) -> Result<bool, AppError> {
    let res = sqlx::query!(
        r#"UPDATE credit_grants
           SET revoked_at = now(), revoked_by = $3
           WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL"#,
        grant_id,
        account_id,
        revoked_by,
    )
    .execute(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(res.rows_affected() > 0)
}

/// The account's comp/premium override (#39, ITEM-2), or the NOT-premium default when no row
/// exists (INV-5). A pure SELECT `check_quota` reads.
pub async fn quota_override(pool: &PgPool, account_id: Uuid) -> Result<QuotaOverride, AppError> {
    let row = sqlx::query!(
        r#"SELECT premium, reason,
                  set_by AS "set_by?: Uuid",
                  updated_at AS "updated_at: DateTime<Utc>"
           FROM account_quota_override WHERE account_id = $1"#,
        account_id,
    )
    .fetch_optional(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(row
        .map(|r| QuotaOverride {
            premium: r.premium,
            reason: r.reason,
            set_by: r.set_by,
            updated_at: Some(r.updated_at),
        })
        .unwrap_or_default())
}

/// Set (upsert) the account's comp/premium override (#39, ITEM-2). One row per account (PK
/// upsert). `premium = false` leaves the row present but inert (INV-5). Records `set_by`/`reason`
/// for audit.
pub async fn set_quota_override(
    pool: &PgPool,
    account_id: Uuid,
    premium: bool,
    reason: Option<&str>,
    set_by: Uuid,
) -> Result<(), AppError> {
    sqlx::query!(
        r#"INSERT INTO account_quota_override (account_id, premium, reason, set_by, updated_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (account_id)
           DO UPDATE SET premium = $2, reason = $3, set_by = $4, updated_at = now()"#,
        account_id,
        premium,
        reason,
        set_by,
    )
    .execute(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(())
}

// ───────────────────── Billing integration (#60) — encrypted credential config ─────────────────────

/// The raw `billing_integration` singleton row: the ENCRYPTED secret ciphertexts
/// (bytea), the plaintext price-ID mapping, and the audit `updated_by`. The
/// ciphertext bytes never leave this layer un-decrypted (see `client::resolve_secret`).
#[derive(Debug, Clone)]
pub struct BillingIntegrationRow {
    pub stripe_secret_ciphertext: Option<Vec<u8>>,
    pub webhook_secret_ciphertext: Option<Vec<u8>>,
    pub price_ids: serde_json::Value,
    pub updated_by: Option<Uuid>,
}

/// Read the `billing_integration` singleton (#60). The seeded row always exists (a
/// fresh migrate inserts it), so this reads exactly one row.
pub async fn get_billing_integration(pool: &PgPool) -> Result<BillingIntegrationRow, AppError> {
    let row = sqlx::query!(
        r#"SELECT stripe_secret_ciphertext,
                  webhook_secret_ciphertext,
                  price_ids,
                  updated_by
           FROM billing_integration WHERE singleton = true"#,
    )
    .fetch_one(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(BillingIntegrationRow {
        stripe_secret_ciphertext: row.stripe_secret_ciphertext,
        webhook_secret_ciphertext: row.webhook_secret_ciphertext,
        price_ids: row.price_ids,
        updated_by: row.updated_by,
    })
}

/// Persist a PARTIAL billing-integration update (#60), stamping the audit
/// `updated_by`/`updated_at`. Each field is applied via SQL `COALESCE($n, col)` so an
/// absent field (`None`) is LEFT UNCHANGED — a price-only edit never wipes a stored
/// secret, and a secret rotate never clears the price mapping. The ciphertexts are
/// pre-encrypted by the caller (`encrypt_secret`); this layer only stores bytes.
pub async fn upsert_billing_integration(
    pool: &PgPool,
    stripe_secret_ciphertext: Option<Vec<u8>>,
    webhook_secret_ciphertext: Option<Vec<u8>>,
    price_ids: Option<serde_json::Value>,
    updated_by: Uuid,
) -> Result<(), AppError> {
    sqlx::query!(
        r#"UPDATE billing_integration
           SET stripe_secret_ciphertext  = COALESCE($1, stripe_secret_ciphertext),
               webhook_secret_ciphertext = COALESCE($2, webhook_secret_ciphertext),
               price_ids                 = COALESCE($3, price_ids),
               updated_by                = $4,
               updated_at                = now()
           WHERE singleton = true"#,
        stripe_secret_ciphertext,
        webhook_secret_ciphertext,
        price_ids,
        updated_by,
    )
    .execute(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(())
}
