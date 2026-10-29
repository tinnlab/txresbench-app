//! The `account` module's SQLite query-surface semantics — TESTS.md TEST-24,
//! the ITEM-17 per-item test.
//!
//! TESTS.md as written: "account scope/search/admin-suspend queries behave on
//! SQLite per the existing `tests/account/**` suite (run against sqlite),
//! including `= ANY(uuid[])` membership and the `COUNT(*) FILTER` →
//! `SUM(CASE …)` rewrite counts."
//!
//! Where the repository lives: the app's modules are single-driver (DEC-1), so
//! the ported SQL sits IN `src/modules/account/{repository,scope,seat}.rs` and
//! is verified against the real sqlite build DB by the sqlx macros at
//! `cargo check` (syntax + schema + bind arity + type coherence). What a test
//! adds on top is the RUNTIME semantics those checks cannot prove — the DEC-8
//! type map's decode paths and the rewrite shapes' value semantics. This file
//! pins them with independent SQL against the REAL ported chain (TEST-14's
//! harness: `compose_sqlite_chain` + `apply_chain`), so each assertion is a
//! behavior pin, not a copy of the repository's SQL:
//!
//! 1. `personal_accounts_of`'s `= ANY(uuid[])` port: a 16-byte-BLOB
//!    `personal_user_id` membership through `unhex()` + `json_each` (the
//!    ITEM-15 convention) finds exactly the bound ids.
//! 2. `ensure_personal_account_in_tx`'s partial-unique upsert: the
//!    `ON CONFLICT (personal_user_id) WHERE kind = 'personal' … RETURNING id`
//!    returns the EXISTING row on the conflict path (no stray row, no second
//!    read).
//! 3. `enforce_invitation_mint_budget`'s rewrite: `SUM(CASE …)` + `COALESCE`
//!    over an empty ledger is 0, and the canonical-`strftime` day/hour cut-offs
//!    exclude aged mint rows.
//! 4. `create_invitation`'s member probe: the `trim(char(32)||char(9)||…` port
//!    of `btrim(…, E' \t\n\r\f\v')` matches a stored lowercase address.
//! 5. `set_admin_suspended`'s `CASE WHEN $1 THEN strftime(…)`: bool binds,
//!    canonical stamps, reactivate clears the audit columns.
//! 6. the invitation claim predicate's canonical clock: a canonical-format
//!    `expires_at` bind sorts against `strftime('%Y-%m-%dT%H:%M:%fZ','now')`
//!    correctly (lexicographic == chronological) and decodes to
//!    `DateTime<Utc>` from TEXT.
//! 7. the `account_member_events` row insert + the redacting scoped read:
//!    app-side `id` bind (the ITEM-10 chain dropped the PG `gen_random_uuid()`
//!    defaults per DEC-12 — every account INSERT names the id explicitly
//!    since ITEM-17), `admin` rows NULL their `actor_user_id`.
//! 8. the serialization substitution: `BEGIN IMMEDIATE` + the
//!    `sqlite3_get_autocommit` probe (in a transaction == 0); the
//!    `SEAT_UNSERIALIZED_ISOLATION` arm is PG-only and does not exist here.
//!
//! (ITEM-17's per-item verification note: this file is authored in the red
//! window — ITEM-12 flipped the tree, ITEM-25 turns it green — so its first
//! run is ITEM-25's, alongside the rest of the ported suite; the identical
//! semantics were executed ITEM-17's scratch probe against this same chain.)

use super::apply_chain::{apply_chain, compose_sqlite_chain, Scratch};
use uuid::Uuid;

fn uuid_list_json(ids: &[Uuid]) -> String {
    serde_json::to_string(&ids.iter().map(|id| id.simple().to_string()).collect::<Vec<_>>())
        .expect("JSON array")
}

/// TEST-24 — the account query surface's runtime semantics on SQLite.
#[tokio::test]
async fn account_query_surface_behaves_on_sqlite() {
    let scratch = Scratch::new("module-account");
    let merged = compose_sqlite_chain(scratch.path());
    let (pool, _migrator) = apply_chain(&merged, &scratch.path().join("scratch.sqlite")).await;

    let u1 = Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, username, email, display_name) VALUES (?, ?, ?, ?)")
        .bind(u1)
        .bind("alice")
        .bind("alice@example.com")
        .bind("Alice")
        .execute(&pool)
        .await
        .expect("user");
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO accounts (id, kind, name) VALUES (?, 'organization', 'Probe Org')")
        .bind(org)
        .execute(&pool)
        .await
        .expect("org");
    sqlx::query("INSERT INTO account_members (account_id, user_id, role) VALUES (?, ?, 'owner')")
        .bind(org)
        .bind(u1)
        .execute(&pool)
        .await
        .expect("membership");

    // 1. `= ANY(uuid[])` → unhex/json_each membership (personal_accounts_of).
    let personal_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO accounts (id, kind, name, personal_user_id) \
         VALUES (?, 'personal', 'alice', ?)",
    )
    .bind(personal_id)
    .bind(u1)
    .execute(&pool)
    .await
    .expect("personal account");
    let found: Vec<Uuid> = sqlx::query_scalar(
        "SELECT personal_user_id FROM accounts \
         WHERE kind = 'personal' \
           AND personal_user_id IN (SELECT unhex(j.value) FROM json_each($1) AS j)",
    )
    .bind(uuid_list_json(&[u1]))
    .fetch_all(&pool)
    .await
    .expect("membership select");
    assert_eq!(found, vec![u1]);
    let none: Vec<Uuid> = sqlx::query_scalar(
        "SELECT personal_user_id FROM accounts \
         WHERE kind = 'personal' \
           AND personal_user_id IN (SELECT unhex(j.value) FROM json_each($1) AS j)",
    )
    .bind(uuid_list_json(&[Uuid::new_v4()]))
    .fetch_all(&pool)
    .await
    .expect("membership no-match");
    assert!(none.is_empty(), "a non-member id must not match");

    // 2. partial-unique upsert returns the existing row (the ensure path).
    let row_id: Uuid = sqlx::query_scalar(
        "INSERT INTO accounts (id, kind, name, personal_user_id) \
         VALUES ($1, 'personal', $2, $3) \
         ON CONFLICT (personal_user_id) WHERE kind = 'personal' \
             DO UPDATE SET name = accounts.name \
         RETURNING id",
    )
    .bind(Uuid::new_v4())
    .bind("alice-again")
    .bind(u1)
    .fetch_one(&pool)
    .await
    .expect("upsert");
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM accounts WHERE kind = 'personal' AND personal_user_id = ?",
    )
    .bind(u1)
    .fetch_one(&pool)
    .await
    .expect("count");
    assert_eq!(row_id, personal_id, "conflict path returns the existing row");
    assert_eq!(n, 1, "no second personal account");

    // 3. mint-budget rewrite: empty ledger sums to 0; aged rows are excluded.
    let (hour, day): (i64, i64) = sqlx::query_as(
        "SELECT \
           COALESCE(SUM(CASE WHEN actor_user_id = $2 \
                            AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-' || ($3 / 1000000) || ' seconds') \
                       THEN 1 ELSE 0 END), 0), \
           COALESCE(SUM(CASE WHEN account_id = $1 AND actor_user_id IS NOT NULL \
                            AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-' || ($4 / 1000000) || ' seconds') \
                       THEN 1 ELSE 0 END), 0) \
         FROM account_invitation_mints \
         WHERE (actor_user_id = $2 OR account_id = $1) \
           AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-' || ($4 / 1000000) || ' seconds')",
    )
    .bind(org)
    .bind(u1)
    .bind(3_600_000_000i64)
    .bind(86_400_000_000i64)
    .fetch_one(&pool)
    .await
    .expect("empty mint budget");
    assert_eq!((hour, day), (0, 0), "SUM(CASE)+COALESCE over zero rows is 0");
    sqlx::query(
        "INSERT INTO account_invitation_mints \
           (id, account_id, actor_user_id, invitation_id, created_at) \
         VALUES (?, ?, ?, ?, '2020-01-01T00:00:00.000Z')",
    )
    .bind(Uuid::new_v4())
    .bind(org)
    .bind(u1)
    .bind(Uuid::new_v4())
    .execute(&pool)
    .await
    .expect("aged mint");
    let (hour, day): (i64, i64) = sqlx::query_as(
        "SELECT \
           COALESCE(SUM(CASE WHEN actor_user_id = $2 \
                            AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-' || ($3 / 1000000) || ' seconds') \
                       THEN 1 ELSE 0 END), 0), \
           COALESCE(SUM(CASE WHEN actor_user_id = $2 \
                            AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-' || ($4 / 1000000) || ' seconds') \
                       THEN 1 ELSE 0 END), 0) \
         FROM account_invitation_mints \
         WHERE (actor_user_id = $2 OR account_id = $1) \
           AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-' || ($4 / 1000000) || ' seconds')",
    )
    .bind(org)
    .bind(u1)
    .bind(3_600_000_000i64)
    .bind(86_400_000_000i64)
    .fetch_one(&pool)
    .await
    .expect("aged mint budget");
    assert_eq!((hour, day), (0, 0), "the aged row is outside both windows");

    // 4. trim(char(…)) email folding (the already-a-member probe).
    let found = sqlx::query_scalar::<_, Uuid>(
        "SELECT m.user_id FROM account_members m \
          JOIN users u ON u.id = m.user_id \
         WHERE m.account_id = $1 \
           AND lower(trim(u.email, char(32) || char(9) || char(10) || char(13) || char(12) || char(11))) = $2",
    )
    .bind(org)
    .bind("alice@example.com")
    .fetch_optional(&pool)
    .await
    .expect("email membership probe");
    assert_eq!(found, Some(u1));

    // 5. admin-suspend CASE + bool binds + reactivate clears the audit columns.
    sqlx::query(
        "UPDATE accounts \
         SET admin_suspended = $1, \
             admin_suspended_at = CASE WHEN $1 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END, \
             admin_suspended_by = $2, \
             admin_suspend_reason = $3, \
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
         WHERE id = $4",
    )
    .bind(true)
    .bind(u1)
    .bind("probe")
    .bind(org)
    .execute(&pool)
    .await
    .expect("suspend");
    let (susp, at, by): (bool, chrono::DateTime<chrono::Utc>, Uuid) = sqlx::query_as(
        "SELECT admin_suspended, admin_suspended_at, admin_suspended_by FROM accounts WHERE id = ?",
    )
    .bind(org)
    .fetch_one(&pool)
    .await
    .expect("suspend read");
    assert!(susp && at <= chrono::Utc::now() && by == u1);
    sqlx::query(
        "UPDATE accounts \
         SET admin_suspended = $1, \
             admin_suspended_at = CASE WHEN $1 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END, \
             admin_suspended_by = $2, \
             admin_suspend_reason = $3, \
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
         WHERE id = $4",
    )
    .bind(false)
    .bind(None::<Uuid>)
    .bind(None::<&str>)
    .bind(org)
    .execute(&pool)
    .await
    .expect("reactivate");
    let (susp, at): (bool, Option<chrono::DateTime<chrono::Utc>>) =
        sqlx::query_as("SELECT admin_suspended, admin_suspended_at FROM accounts WHERE id = ?")
            .bind(org)
            .fetch_one(&pool)
            .await
            .expect("reactivate read");
    assert!(!susp && at.is_none());

    // 6. canonical clock: the claim predicate + DateTime<Utc> TEXT decode.
    let future = chrono::Utc::now() + chrono::Duration::days(7);
    let future_canon = future.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let inv_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO account_invitations \
           (id, account_id, email, role, token_sha256, expires_at) \
         VALUES (?, ?, 'probe@example.com', 'member', ?, ?)",
    )
    .bind(inv_id)
    .bind(org)
    .bind(vec![0u8; 32])
    .bind(&future_canon)
    .execute(&pool)
    .await
    .expect("invitation");
    let live: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM account_invitations \
         WHERE account_id = $1 \
           AND accepted_at IS NULL AND revoked_at IS NULL \
           AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')",
    )
    .bind(org)
    .fetch_one(&pool)
    .await
    .expect("pending count");
    assert_eq!(live, 1, "canonical text ordering keeps the future expiry live");
    let decoded: chrono::DateTime<chrono::Utc> =
        sqlx::query_scalar("SELECT expires_at FROM account_invitations WHERE id = ?")
            .bind(inv_id)
            .fetch_one(&pool)
            .await
            .expect("expiry decode");
    assert_eq!(decoded.timestamp(), future.timestamp());

    // 7. member-events insert with an app-side id + the redacting scoped read.
    let ev_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO account_member_events \
           (id, account_id, actor_user_id, actor_kind, action, target_user_id, old_role, new_role) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(ev_id)
    .bind(org)
    .bind(u1)
    .bind("admin")
    .bind("role_changed")
    .bind(u1)
    .bind("member")
    .bind("owner")
    .execute(&pool)
    .await
    .expect("event insert");
    let (id, action, actor_uid): (Uuid, String, Option<Uuid>) = sqlx::query_as(
        "SELECT id, action, \
                CASE WHEN actor_kind = 'admin' THEN NULL ELSE actor_user_id END \
         FROM account_member_events \
         WHERE account_id = $1 AND (actor_kind <> 'system' OR action = 'removed') \
         ORDER BY created_at DESC, id DESC",
    )
    .bind(org)
    .fetch_one(&pool)
    .await
    .expect("scoped read");
    assert_eq!(id, ev_id);
    assert_eq!(action, "role_changed");
    assert_eq!(actor_uid, None, "admin rows redact the actor id");

    // 8. serialization substitution: the autocommit probe + BEGIN IMMEDIATE.
    let mut conn = pool.acquire().await.expect("acquire");
    let mut h = conn.lock_handle().await.expect("handle");
    assert!(
        unsafe { libsqlite3_sys::sqlite3_get_autocommit(h.as_raw_handle().as_ptr()) != 0 },
        "autocommit connection is NOT in a transaction"
    );
    drop((h, conn));
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.expect("begin");
    {
        let mut h = tx.lock_handle().await.expect("handle");
        assert!(
            unsafe { libsqlite3_sys::sqlite3_get_autocommit(h.as_raw_handle().as_ptr()) == 0 },
            "an open transaction reports autocommit off"
        );
    }
    tx.commit().await.expect("commit");
}
