//! Crate-scoped DB integration test for `txresbench-notification`.
//!
//! Applies the crate's OWN migration to a fresh throwaway database and
//! round-trips the `Notification` `FromRow` model against the resulting schema.
//! Covers two things the in-source unit tests can't, and the txresbench HTTP inbox
//! tests only reach indirectly:
//!   1. STANDALONE MIGRATION APPLY (gap N-1) — the migration must apply on a bare
//!      DB with none of chat/scheduler/workflow/auth's domain tables present
//!      (the R2 schema knows no domain: kind-specific data rides one `payload`
//!      jsonb column, and there are NO FKs). A negative control asserts the
//!      FK-free posture directly.
//!   2. MIGRATION ↔ MODEL mapping — every `Notification` field (incl. the
//!      `payload` jsonb) selects back from the migrated schema, so a column
//!      rename / type drift fails the suite.
//!
//! The full inbox flow (scheduler → notification, auth gating, owner-scope)
//! stays in txresbench's `tests/notification` — that's assembled-app behavior.
//!
//! Dual-driver (sqlite-store DEC-1 / TEST-23): every test provisions via the
//! shared `common` harness (PG cluster DB or per-test file), so the same suite
//! proves the schema + models on BOTH engines. The model round-trips go through
//! the crate's `repository` (the `routes`-gated macro surface) rather than a
//! raw dynamic SELECT: sqlx's sqlite driver has no `Decode<Sqlite>` for a bare
//! `serde_json::Value`, so on the sqlite leg the macro-verified `JsonValue`
//! TEXT transport IS the mapping path — exercising it is the point, not a
//! workaround. The schema negative controls use the driver's own catalog
//! (`information_schema` on PG, the `pragma_*` table-valued functions on
//! sqlite). The repository suite is `routes`-gated exactly like the surface it
//! drives; under the crate's types-only `default` the schema controls still
//! run.

mod common;

use common::{drop_db, fresh_db};

/// Negative control for N-1: the migrated schema must carry NO foreign-key
/// constraints (an app that has a users table adds the `user_id` FK in its own
/// module migration), otherwise it couldn't apply on a bare DB.
#[tokio::test]
async fn schema_has_no_foreign_keys() {
    let (pool, identity) = fresh_db().await;

    #[cfg(not(feature = "sqlite-backend"))]
    let fk_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM information_schema.table_constraints
         WHERE table_name = 'notifications' AND constraint_type = 'FOREIGN KEY'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    #[cfg(feature = "sqlite-backend")]
    let fk_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM pragma_foreign_key_list('notifications')")
            .fetch_one(&pool)
            .await
            .unwrap();

    assert_eq!(
        fk_count, 0,
        "the crate migration must be domain-agnostic (no FKs) so it applies standalone"
    );

    drop_db(&identity).await;
}

/// Negative control for the R2 schema: the former domain-specific FK columns
/// (`scheduled_task_id` / `workflow_run_id` / `conversation_id`) are GONE — the
/// only structured slot is `payload`. Asserting their absence guards a
/// regression that re-introduces domain columns into the SDK schema.
#[tokio::test]
async fn schema_has_payload_and_no_domain_fk_columns() {
    let (pool, identity) = fresh_db().await;

    #[cfg(not(feature = "sqlite-backend"))]
    let cols: Vec<String> = sqlx::query_scalar(
        "SELECT column_name FROM information_schema.columns
         WHERE table_name = 'notifications'",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    #[cfg(feature = "sqlite-backend")]
    let cols: Vec<String> =
        sqlx::query_scalar("SELECT name FROM pragma_table_info('notifications')")
            .fetch_all(&pool)
            .await
            .unwrap();

    assert!(
        cols.iter().any(|c| c == "payload"),
        "the R2 schema carries a single `payload` jsonb column"
    );
    for gone in ["scheduled_task_id", "workflow_run_id", "conversation_id"] {
        assert!(
            !cols.iter().any(|c| c == gone),
            "domain FK column `{gone}` must NOT exist in the SDK schema (moved into payload)"
        );
    }

    drop_db(&identity).await;
}

/// Pure builder-setter coverage (no DB): `.payload(json)` sets the structured
/// slot and `.body()` / `.silent()` behave. This replaces the removed
/// `.task()` / `.workflow_run()` / `.conversation()` setters (the R2 model has
/// only `payload`).
#[test]
fn builder_payload_setter() {
    use uuid::Uuid;
    use txresbench_notification::models::NewNotification;

    let n = NewNotification::new(Uuid::new_v4(), "task_done", "Task finished")
        .payload(serde_json::json!({ "scheduled_task_id": "t-1" }));
    assert_eq!(n.payload["scheduled_task_id"], "t-1");
    assert!(n.interrupt, "interrupts by default");

    let silent = NewNotification::new(Uuid::new_v4(), "run_done", "Run finished").silent();
    assert!(!silent.interrupt);
    assert_eq!(
        silent.payload,
        serde_json::json!({}),
        ".silent() leaves payload at the empty-object default"
    );
}

/// The DB round-trip suite (model ↔ migrated schema, plus the whole repository
/// macro surface). Compiled only when the `routes` feature is on — the surface
/// it drives is `routes`-gated by the crate itself.
#[cfg(feature = "routes")]
mod db_tests {
    use super::{drop_db, fresh_db};
    use uuid::Uuid;
    use txresbench_core::DbPool;
    use txresbench_notification::models::{NewNotification, Notification};
    use txresbench_notification::repository;

    /// Seed one notification with a kind-specific payload; returns
    /// `(notification_id, payload)`.
    async fn seed_user_notification(pool: &DbPool, user_id: Uuid) -> (Uuid, serde_json::Value) {
        // R2 payload model: kind-specific ids (conversation_id here) ride the
        // `payload` jsonb column, not dedicated FK columns.
        let payload = serde_json::json!({ "conversation_id": Uuid::new_v4().to_string() });
        let new = NewNotification::new(user_id, "task_done", "Task finished")
            .body("your scheduled task completed")
            .payload(payload.clone());
        let row = repository::insert(pool, new)
            .await
            .expect("insert notification");
        (row.id, payload)
    }

    #[tokio::test]
    async fn migration_applies_standalone_and_model_round_trips() {
        let (pool, identity) = fresh_db().await;

        let user_id = Uuid::new_v4();
        let (id, payload) = seed_user_notification(&pool, user_id).await;
        let row = repository::get_for_user(&pool, user_id, id)
            .await
            .expect("get notification")
            .expect("the inserted row is found");

        // Round-trip every field through the FromRow model.
        assert_eq!(row.id, id);
        assert_eq!(row.user_id, user_id);
        assert_eq!(row.kind, "task_done");
        assert_eq!(row.title, "Task finished");
        assert_eq!(row.body, "your scheduled task completed");
        assert!(row.interrupt);
        assert_eq!(
            row.payload, payload,
            "the payload jsonb round-trips verbatim through the FromRow model"
        );
        assert_eq!(
            row.payload["conversation_id"], payload["conversation_id"],
            "a kind-specific id is read back out of the payload"
        );
        assert!(
            row.is_unread(),
            "a freshly-inserted notification has NULL read_at → unread"
        );
        assert!(
            row.created_at.timestamp() > 0,
            "created_at defaulted to now()"
        );

        // Owner-scoped get: a stranger's lookup resolves None.
        assert!(
            repository::get_for_user(&pool, Uuid::new_v4(), id)
                .await
                .expect("get notification")
                .is_none(),
            "the inbox is strictly owner-scoped"
        );

        drop_db(&identity).await;
    }

    /// Raw insert that OMITS `payload` (so the column DEFAULT applies) and
    /// returns the new id. Driver-selected: the PG chain's `id` carries the
    /// `gen_random_uuid()` default (base behavior); the SQLite chain
    /// deliberately has NO id default (DEC-12 — every write binds its id
    /// app-side), so that leg binds the id explicitly.
    #[cfg(not(feature = "sqlite-backend"))]
    async fn insert_without_payload(pool: &DbPool, new: &NewNotification) -> Uuid {
        sqlx::query_scalar(
            "INSERT INTO notifications (user_id, kind, title, interrupt)
             VALUES ($1, $2, $3, $4) RETURNING id",
        )
        .bind(new.user_id)
        .bind(&new.kind)
        .bind(&new.title)
        .bind(new.interrupt)
        .fetch_one(pool)
        .await
        .expect("insert notification with no payload")
    }

    #[cfg(feature = "sqlite-backend")]
    async fn insert_without_payload(pool: &DbPool, new: &NewNotification) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query_scalar(
            "INSERT INTO notifications (id, user_id, kind, title, interrupt)
             VALUES ($1, $2, $3, $4, $5) RETURNING id",
        )
        .bind(id)
        .bind(new.user_id)
        .bind(&new.kind)
        .bind(&new.title)
        .bind(new.interrupt)
        .fetch_one(pool)
        .await
        .expect("insert notification with no payload")
    }

    #[tokio::test]
    async fn payload_defaults_to_empty_object() {
        let (pool, identity) = fresh_db().await;

        // Omit payload on insert → the column DEFAULT applies, and the builder's
        // own default is likewise an empty object.
        let new = NewNotification::new(Uuid::new_v4(), "digest", "Daily digest");
        assert_eq!(
            new.payload,
            serde_json::json!({}),
            "the builder defaults payload to {{}}"
        );

        let id = insert_without_payload(&pool, &new).await;

        let row = repository::get_for_user(&pool, new.user_id, id)
            .await
            .expect("get notification")
            .expect("the defaulted row is found");
        assert_eq!(
            row.payload,
            serde_json::json!({}),
            "the column DEFAULT yields an empty object row"
        );

        drop_db(&identity).await;
    }

    #[tokio::test]
    async fn silent_builder_yields_a_durable_only_row() {
        let (pool, identity) = fresh_db().await;

        let user_id = Uuid::new_v4();
        let new = NewNotification::new(user_id, "digest", "Daily digest").silent();
        let row = repository::insert(&pool, new)
            .await
            .expect("insert silent notification");
        assert!(
            !row.interrupt,
            "`.silent()` → interrupt=false: a durable inbox row with no live toast"
        );

        drop_db(&identity).await;
    }

    /// The per-item verification for the query port: the WHOLE repository macro
    /// surface round-trips on the driver-under-test — insert / owner-scoped get
    /// / unread filter + totals / unread count / mark-read idempotence /
    /// mark-all-read / retention prune (0 = no-op, N removes the backdated row)
    /// / delete. On the sqlite leg this exercises every rewritten construct
    /// (the `JsonValue` TEXT transport, the `$2 = FALSE` filter, the
    /// `SUM(CASE …)` + `COALESCE` unread pivot, the `strftime` now/interval
    /// forms).
    #[tokio::test]
    async fn repository_macro_surface_round_trips() {
        let (pool, identity) = fresh_db().await;

        let user = Uuid::new_v4();
        let (row_id, payload) = seed_user_notification(&pool, user).await;
        assert_eq!(
            repository::unread_count(&pool, user)
                .await
                .expect("unread count"),
            1
        );

        let (items, total, unread) = repository::list_for_user(&pool, user, true, 1, 20)
            .await
            .expect("list unread");
        assert_eq!((items.len(), total, unread), (1, 1, 1));
        assert_eq!(
            items[0].payload, payload,
            "the list row re-maps the payload"
        );
        let (items, total, unread) = repository::list_for_user(&pool, user, false, 1, 20)
            .await
            .expect("list all");
        assert_eq!((items.len(), total, unread), (1, 1, 1));

        // Owner scope: a second user's inbox is invisible to the first.
        let other = Uuid::new_v4();
        repository::insert(&pool, NewNotification::new(other, "k", "t"))
            .await
            .expect("insert other user's notification");
        assert_eq!(
            repository::unread_count(&pool, other)
                .await
                .expect("other unread count"),
            1
        );
        let (items, total, _) = repository::list_for_user(&pool, user, false, 1, 20)
            .await
            .expect("list stays owner-scoped");
        assert_eq!((items.len(), total), (1, 1));

        // Mark-read is idempotent and flips the unread totals.
        assert!(
            repository::mark_read(&pool, user, row_id)
                .await
                .expect("mark read")
        );
        assert!(
            !repository::mark_read(&pool, user, row_id)
                .await
                .expect("mark read twice"),
            "mark-read is idempotent"
        );
        assert_eq!(
            repository::unread_count(&pool, user)
                .await
                .expect("unread count after mark"),
            0
        );
        let (_, _, unread) = repository::list_for_user(&pool, user, true, 1, 20)
            .await
            .expect("list unread after mark");
        assert_eq!(unread, 0);

        assert_eq!(
            repository::mark_all_read(&pool, other)
                .await
                .expect("mark all read"),
            1
        );
        assert_eq!(
            repository::mark_all_read(&pool, other)
                .await
                .expect("mark all read again"),
            0,
            "mark-all-read on an empty unread set affects no rows"
        );

        // Retention: 0 days is a no-op; N days removes only the backdated row.
        assert_eq!(
            repository::prune_older_than(&pool, 0)
                .await
                .expect("prune 0"),
            0
        );
        let old = repository::insert(&pool, NewNotification::new(user, "k", "t"))
            .await
            .expect("insert backdatable notification");
        #[cfg(not(feature = "sqlite-backend"))]
        sqlx::query(
            "UPDATE notifications SET created_at = now() - interval '10 days' WHERE id = $1",
        )
        .bind(old.id)
        .execute(&pool)
        .await
        .expect("backdate notification (postgres)");
        #[cfg(feature = "sqlite-backend")]
        sqlx::query(
            "UPDATE notifications SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 days') \
             WHERE id = $1",
        )
        .bind(old.id)
        .execute(&pool)
        .await
        .expect("backdate notification (sqlite)");
        assert_eq!(
            repository::prune_older_than(&pool, 7)
                .await
                .expect("prune 7 days"),
            1,
            "only the backdated row is older than the retention window"
        );
        assert!(
            repository::get_for_user(&pool, user, row_id)
                .await
                .expect("get surviving row")
                .is_some(),
            "the fresh row survives the prune"
        );

        // Delete: owner-scoped, one-shot (the pruned row is already gone; use a
        // fresh one).
        let doomed = repository::insert(&pool, NewNotification::new(user, "k", "t"))
            .await
            .expect("insert deletable notification");
        assert!(
            repository::delete(&pool, user, doomed.id)
                .await
                .expect("delete"),
            "delete removes the row"
        );
        assert!(
            !repository::delete(&pool, user, doomed.id)
                .await
                .expect("delete twice"),
            "a second delete affects no rows"
        );

        drop_db(&identity).await;
    }

    /// The bare `FromRow` decode of a NULL `read_at` + the integer `interrupt`
    /// flag work off the raw row (the model mapping on the sqlite leg is the
    /// macro surface's job — this pins the DEFAULTed schema rows).
    #[tokio::test]
    async fn column_defaults_are_visible_to_the_model() {
        let (pool, identity) = fresh_db().await;

        let user_id = Uuid::new_v4();
        let new = NewNotification::new(user_id, "digest", "Daily digest");
        let id = insert_without_payload(&pool, &new).await;
        let row: Notification = repository::get_for_user(&pool, user_id, id)
            .await
            .expect("get")
            .expect("row");
        assert_eq!(row.payload, serde_json::json!({}));
        assert_eq!(row.body, "", "the body column default applies");
        assert!(row.interrupt, "the interrupt column default applies");
        assert!(
            row.read_at.is_none(),
            "read_at stays NULL for a freshly inserted row"
        );

        drop_db(&identity).await;
    }
}
