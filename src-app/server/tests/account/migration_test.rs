//! A1 schema + grant + backfill-idempotency acceptance tests (TEST-4/5/7/8).

use uuid::Uuid;

use super::{create_user, pool_for, setup_admin};
use crate::common::TestServer;

/// The two idempotent backfill statements — a VERBATIM copy of the
/// `202608040012_account_baseline.sql` data-backfill block. A boot-time migration
/// on an EMPTY users table backfills nothing, so re-running the block here (against
/// users created after boot) is the only way to prove PROV-A1-10 / INV-2 on a
/// populated DB. If the migration's backfill changes, this copy must change with it
/// (the test then fails loudly, which is the point).
async fn run_backfill(pool: &sqlx::SqlitePool) {
    sqlx::query(
        r#"INSERT INTO accounts (id, kind, name, personal_user_id)
           SELECT randomblob(16), 'personal', u.username, u.id
           FROM users u
           WHERE NOT EXISTS (
               SELECT 1 FROM accounts a
               WHERE a.kind = 'personal' AND a.personal_user_id = u.id
           )"#,
    )
    .execute(pool)
    .await
    .expect("backfill accounts");

    sqlx::query(
        r#"INSERT INTO account_members (account_id, user_id, role)
           SELECT a.id, a.personal_user_id, 'owner'
           FROM accounts a
           WHERE a.kind = 'personal' AND a.personal_user_id IS NOT NULL
           ON CONFLICT (account_id, user_id) DO NOTHING"#,
    )
    .execute(pool)
    .await
    .expect("backfill members");
}

// TEST-4 (covers ITEM-2, ITEM-3): after migrate, the schema is exactly as
// specified — tables, CHECK constraints, the partial unique index, the composite
// PK, and idx_account_members_user; a second personal row for one user violates
// uq_accounts_personal_user; a role='viewer' insert violates the role CHECK.
#[tokio::test]
async fn schema_shape_and_constraints() {
    let server = TestServer::spawn().await;
    let pool = pool_for(&server).await;

    // tables exist
    for table in ["accounts", "account_members"] {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=$1)",
        )
        .bind(table)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(exists, "table {table} exists after migrate");
    }

    // named constraints exist (kind CHECK, personal-has-user CHECK, role CHECK) —
    // SQLite keeps named constraints in the CREATE TABLE text (`sqlite_master.sql`),
    // the same census `pg_constraint` was.
    for con in [
        "accounts_kind_check",
        "accounts_personal_has_user",
        "account_members_role_check",
    ] {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM sqlite_master \
              WHERE type='table' AND sql LIKE '%CONSTRAINT ' || $1 || '%')",
        )
        .bind(con)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(exists, "constraint {con} exists");
    }

    // partial unique index + user index exist
    for idx in ["uq_accounts_personal_user", "idx_account_members_user"] {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type='index' AND name=$1)",
        )
        .bind(idx)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(exists, "index {idx} exists");
    }

    // composite PK on account_members(account_id, user_id)
    let pk_cols: Vec<String> = sqlx::query_scalar(
        r#"SELECT name FROM pragma_table_info('account_members')
           WHERE pk > 0 ORDER BY pk"#,
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        pk_cols,
        vec!["account_id".to_string(), "user_id".to_string()]
    );

    // Seed a user + a personal account, then prove the constraints bite.
    let admin = setup_admin(&server).await;
    let alice = create_user(&server, &admin, "alice", "alice@x.test").await;

    // A5's create_user (ITEM-1) now auto-ensures alice's personal account; clear it so
    // the raw "insert first personal account" below succeeds and the constraint checks
    // run from a clean state (pre-A5 behavior).
    sqlx::query("DELETE FROM accounts WHERE kind = 'personal' AND personal_user_id = $1")
        .bind(alice)
        .execute(&pool)
        .await
        .expect("clear the A5 auto-created account");

    let acct_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO accounts (id, kind, name, personal_user_id) VALUES ($1, 'personal', 'alice', $2)",
    )
    .bind(acct_id)
    .bind(alice)
    .execute(&pool)
    .await
    .expect("insert first personal account");

    // A SECOND personal account for the same user violates uq_accounts_personal_user.
    let dup = sqlx::query(
        "INSERT INTO accounts (id, kind, name, personal_user_id) VALUES ($1, 'personal', 'alice2', $2)",
    )
    .bind(Uuid::new_v4())
    .bind(alice)
    .execute(&pool)
    .await;
    assert!(
        dup.is_err(),
        "second personal account for one user is rejected"
    );

    // A role='viewer' membership violates account_members_role_check.
    let bad_role = sqlx::query(
        "INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'viewer')",
    )
    .bind(acct_id)
    .bind(alice)
    .execute(&pool)
    .await;
    assert!(
        bad_role.is_err(),
        "role='viewer' is rejected by the role CHECK"
    );

    // A bad kind violates accounts_kind_check.
    let bad_kind = sqlx::query(
        "INSERT INTO accounts (id, kind, name) VALUES ($1, 'team', 'x')",
    )
    .bind(Uuid::new_v4())
        .execute(&pool)
        .await;
    assert!(
        bad_kind.is_err(),
        "kind='team' is rejected by the kind CHECK"
    );
}

// TEST-5 [acceptance, PROV-A1-8]: the Users group holds account::read after
// migrate and does NOT hold account::manage. Bound by CONS-A4-4.
#[tokio::test]
async fn users_group_holds_account_read_not_manage() {
    let server = TestServer::spawn().await;
    let pool = pool_for(&server).await;

    let perms: Vec<String> =
        sqlx::query_scalar("SELECT value FROM groups, json_each(groups.permissions) WHERE name = 'Users'")
            .fetch_all(&pool)
            .await
            .unwrap();

    assert!(
        perms.iter().any(|p| p == "account::read"),
        "Users group is granted account::read: {perms:?}"
    );
    assert!(
        !perms.iter().any(|p| p == "account::manage"),
        "Users group must NOT hold account::manage (admins hold it via *): {perms:?}"
    );
}

// TEST-7 (covers ITEM-1, ITEM-9): the account module registers — the server boots
// with it present (spawn succeeds) and the accounts schema is live. (The
// SyncEntity::Account/::AccountMember serialization is pinned by the in-source unit
// test in sync/event.rs + saas_gating_test.)
#[tokio::test]
async fn account_module_boots_and_schema_is_live() {
    let server = TestServer::spawn().await;
    let pool = pool_for(&server).await;
    // A trivial read against the module's table proves the migration applied and
    // the module linked into the booted binary.
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM accounts")
        .fetch_one(&pool)
        .await
        .expect("accounts table is queryable");
    assert_eq!(count, 0, "fresh DB: no accounts until users are created");
}

// TEST-8 [acceptance, INV-2, PROV-A1-10]: applying the baseline data backfill TWICE
// leaves exactly one personal account + one owner membership per pre-existing user
// (idempotent, no duplicates) — the AC-INV-8 double-apply proof.
#[tokio::test]
async fn backfill_is_idempotent_and_one_personal_per_user() {
    let server = TestServer::spawn().await;
    let pool = pool_for(&server).await;
    let admin = setup_admin(&server).await;

    // Three users created AFTER boot → no backfill ran for them yet.
    let u1 = create_user(&server, &admin, "user1", "u1@x.test").await;
    let u2 = create_user(&server, &admin, "user2", "u2@x.test").await;
    let u3 = create_user(&server, &admin, "user3", "u3@x.test").await;
    let users = [u1, u2, u3];

    // Apply the backfill TWICE (the double-apply proof).
    run_backfill(&pool).await;
    run_backfill(&pool).await;

    for u in users {
        let personal_accounts: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM accounts WHERE kind='personal' AND personal_user_id=$1",
        )
        .bind(u)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(personal_accounts, 1, "exactly one personal account for {u}");

        let owner_memberships: i64 = sqlx::query_scalar(
            r#"SELECT count(*) FROM account_members m
               JOIN accounts a ON a.id = m.account_id
               WHERE a.personal_user_id = $1 AND m.user_id = $1 AND m.role = 'owner'"#,
        )
        .bind(u)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(owner_memberships, 1, "exactly one owner membership for {u}");
    }

    // Every user (including the admin created by setup_admin) has EXACTLY ONE
    // personal account, joinable by personal_user_id (PROV-A1-10 shape) — the
    // personal-account count equals the user count, no duplicates.
    let user_count: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
        .fetch_one(&pool)
        .await
        .unwrap();
    let total_personal: i64 =
        sqlx::query_scalar("SELECT count(*) FROM accounts WHERE kind='personal'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        total_personal, user_count,
        "one personal account per user, no duplicates"
    );
    // A personal account per user, joinable by the FK (no orphan personal rows).
    let joinable: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM accounts a JOIN users u ON u.id = a.personal_user_id WHERE a.kind='personal'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        joinable, user_count,
        "every personal account joins its user"
    );
}
