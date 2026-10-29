//! The `project` module's SQLite query-surface semantics — TESTS.md TEST-25,
//! the ITEM-18 per-item test.
//!
//! TESTS.md as written: "project list/search (instr/lower rewrite), scope
//! joins, owner picker search return the same ASCII-fixture rows as ILIKE,
//! and the effective-permission aggregates match."
//!
//! Where the repository lives: the app's modules are single-driver (DEC-1),
//! so the ported SQL sits IN `src/modules/project/repository.rs` and is
//! verified against the real sqlite build DB by the sqlx macros at
//! `cargo check` (syntax + schema + bind arity + type coherence). What a test
//! adds on top is the RUNTIME semantics those checks cannot prove — the
//! DEC-8 type map's decode paths and the rewrite shapes' value semantics.
//! This file pins them with independent SQL against the REAL ported chain
//! (TEST-14's harness: `compose_sqlite_chain` + `apply_chain`), so each
//! assertion is a behavior pin, not a copy of the repository's SQL:
//!
//! 1. `list_visible`'s search: `instr(lower(name), lower($1)) > 0` (DEC-11 —
//!    the PG `ILIKE '%' || $1 || '%'` port) returns the same ASCII-fixture
//!    rows regardless of needle case, the NULL-search leg returns the full
//!    visible set, and the search can never leak a non-visible project.
//! 2. the effective-permission aggregates: the `CASE … MAX(share_rank,
//!    membership_rank)` port labels the owner branch, the accepted-share
//!    level and the account-membership floor the way the PG GREATEST did
//!    (owner > editor > viewer; a bare co-member floors at Viewer).
//! 3. `admin_search_users`: the same `instr(lower(…))` port across username
//!    AND email; NULL query → every user (the "empty query → first `limit`"
//!    contract).
//! 4. the admin aggregates: `COUNT(*) FILTER` → `COALESCE(SUM(CASE …), 0)`
//!    over a no-orphan set is 0, and flips to 1 when the owner is
//!    deactivated; the 'orphaned' status filter then names exactly that
//!    project; `MAX(a, b)` last-activity (the GREATEST port) sorts correctly.
//! 5. the transfer surface: the `uq_project_transfers_pending` race surfaces
//!    as the sqlx-sqlite extended code `2067` (what the repository's 409
//!    `TRANSFER_PENDING` mapping matches), the `DELETE … WHERE id IN (…)`
//!    RETURNING port of `DELETE … USING` cancels both directions' pending
//!    rows, and the `project_settings` singleton ON CONFLICT upsert returns
//!    the single row.
//!
//! (ITEM-18's per-item verification note: this file is authored in the red
//! window — ITEM-12 flipped the tree, ITEM-25 turns it green — so its first
//! run is ITEM-25's, alongside the rest of the ported suite; the identical
//! semantics were executed by the ITEM-18 scratch probe against this same
//! chain.)

use super::apply_chain::{apply_chain, compose_sqlite_chain, Scratch};
use uuid::Uuid;

async fn seed(pool: &sqlx::SqlitePool) -> (Uuid, Uuid, Uuid, Uuid, Uuid, Uuid, Uuid) {
    // users A (org owner), B (org member), C (share recipient only);
    // org account; projects: Alpha Beta (org), gamma gap (org), delta
    // (A's personal), Beta Max (org) — the TEST-17 ASCII fixture names.
    let u_a = Uuid::new_v4();
    let u_b = Uuid::new_v4();
    let u_c = Uuid::new_v4();
    for (id, name, email) in [
        (u_a, "alice", "alice@example.com"),
        (u_b, "bob", "bob@example.com"),
        (u_c, "carol", "carol@example.com"),
    ] {
        sqlx::query("INSERT INTO users (id, username, email, display_name) VALUES (?, ?, ?, ?)")
            .bind(id)
            .bind(name)
            .bind(email)
            .bind(name)
            .execute(pool)
            .await
            .expect("user");
    }
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO accounts (id, kind, name) VALUES (?, 'organization', 'Org')")
        .bind(org)
        .execute(pool)
        .await
        .expect("org");
    let personal_a = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO accounts (id, kind, name, personal_user_id) VALUES (?, 'personal', 'a', ?)",
    )
    .bind(personal_a)
    .bind(u_a)
    .execute(pool)
    .await
    .expect("personal A");
    sqlx::query("INSERT INTO account_members (account_id, user_id, role) VALUES (?, ?, 'owner')")
        .bind(org)
        .bind(u_a)
        .execute(pool)
        .await
        .expect("org owner");
    sqlx::query("INSERT INTO account_members (account_id, user_id, role) VALUES (?, ?, 'member')")
        .bind(org)
        .bind(u_b)
        .execute(pool)
        .await
        .expect("org member");
    sqlx::query("INSERT INTO account_members (account_id, user_id, role) VALUES (?, ?, 'owner')")
        .bind(personal_a)
        .bind(u_a)
        .execute(pool)
        .await
        .expect("personal owner");
    let p_org = Uuid::new_v4();
    let p_shared = Uuid::new_v4();
    let p_personal = Uuid::new_v4();
    let p_beta_max = Uuid::new_v4();
    for (id, name, acct) in [
        (p_org, "Alpha Beta", org),
        (p_shared, "gamma gap", org),
        (p_personal, "delta", personal_a),
        (p_beta_max, "Beta Max", org),
    ] {
        sqlx::query(
            "INSERT INTO projects (id, owner_id, account_id, name, description) \
             VALUES (?, ?, ?, ?, '')",
        )
        .bind(id)
        .bind(u_a)
        .bind(acct)
        .bind(name)
        .execute(pool)
        .await
        .expect("project");
    }
    sqlx::query(
        "INSERT INTO project_shares (id, project_id, owner_id, recipient_id, permission_level, status) \
         VALUES (?, ?, ?, ?, 'editor', 'accepted')",
    )
    .bind(Uuid::new_v4())
    .bind(p_shared)
    .bind(u_a)
    .bind(u_c)
    .execute(pool)
    .await
    .expect("C share");
    (u_a, u_b, u_c, org, p_org, p_shared, p_beta_max)
}

/// TEST-25 (search + scope leg): the instr/lower parity and the
/// effective-permission aggregates, on the TEST-17 ASCII fixture names.
#[tokio::test]
async fn project_search_and_permission_aggregates_match() {
    let scratch = Scratch::new("project-module-1");
    let merged = compose_sqlite_chain(scratch.path());
    let (pool, _migrator) = apply_chain(&merged, &scratch.path().join("scratch.sqlite")).await;
    let (u_a, u_b, u_c, _org, _p_org, p_shared, _p_beta_max) = seed(&pool).await;

    // --- the DEC-11 search rewrite: needle case does not change the set ---
    let search = |needle: Option<&'static str>, uid: Uuid| {
        let pool = pool.clone();
        async move {
            let rows: Vec<String> = sqlx::query_scalar(
                r#"SELECT s.name FROM projects s
                   LEFT JOIN project_shares sh
                     ON sh.project_id = s.id AND sh.recipient_id = $1 AND sh.status = 'accepted'
                   WHERE (s.account_id IN (SELECT am.account_id FROM account_members am
                                            WHERE am.user_id = $1)
                          OR sh.id IS NOT NULL)
                     AND ($2 IS NULL OR instr(lower(s.name), lower($2)) > 0)
                   ORDER BY s.name"#,
            )
            .bind(uid)
            .bind(needle.map(|n| n.to_string()))
            .fetch_all(&pool)
            .await
            .expect("search");
            rows
        }
    };
    assert_eq!(
        search(Some("alpha"), u_a).await,
        vec!["Alpha Beta".to_string()]
    );
    assert_eq!(
        search(Some("BETA"), u_a).await,
        vec!["Alpha Beta".to_string(), "Beta Max".to_string()],
        "needle case does not change the result set (ILIKE parity)"
    );
    assert_eq!(
        search(Some("GAP"), u_a).await,
        vec!["gamma gap".to_string()]
    );
    assert_eq!(
        search(None, u_a).await.len(),
        4,
        "NULL search → full visible set"
    );
    assert!(
        search(Some("alpha"), u_c).await.is_empty(),
        "search cannot leak a non-visible project"
    );

    // --- the effective-permission aggregates (owner branch, share, floor) ---
    // The repository's label computation: owner branch (owner_id + current
    // membership) else MAX(share rank, account-floor rank) → owner/editor/viewer.
    let label = |uid: Uuid| {
        let pool = pool.clone();
        async move {
            let rows: Vec<(String, String)> = sqlx::query_as(
                r#"SELECT s.name,
                          CASE WHEN s.owner_id = $1
                                    AND s.account_id IN (SELECT am.account_id
                                                           FROM account_members am
                                                          WHERE am.user_id = $1)
                               THEN 'owner'
                               ELSE CASE MAX(
                                      CASE sh.permission_level WHEN 'editor' THEN 2
                                                               WHEN 'viewer' THEN 1 ELSE 0 END,
                                      COALESCE((SELECT CASE am.role WHEN 'owner' THEN 3
                                                                     WHEN 'admin' THEN 2 ELSE 1 END
                                                  FROM account_members am
                                                 WHERE am.account_id = s.account_id
                                                   AND am.user_id = $1), 0))
                                    WHEN 3 THEN 'owner' WHEN 2 THEN 'editor' ELSE 'viewer' END
                               END
                          FROM projects s
                          LEFT JOIN project_shares sh
                            ON sh.project_id = s.id AND sh.recipient_id = $1 AND sh.status = 'accepted'
                          WHERE (s.account_id IN (SELECT am.account_id FROM account_members am
                                                   WHERE am.user_id = $1)
                                 OR sh.id IS NOT NULL)
                          ORDER BY s.name"#,
            )
            .bind(uid)
            .fetch_all(&pool)
            .await
            .expect("labels");
            rows
        }
    };
    let a_labels = label(u_a).await;
    assert_eq!(a_labels.len(), 4);
    assert!(
        a_labels.iter().all(|(_, p)| p == "owner"),
        "A resolves owner everywhere: {a_labels:?}"
    );
    let b_labels = label(u_b).await;
    assert_eq!(
        b_labels,
        vec![
            ("Alpha Beta".to_string(), "viewer".to_string()),
            ("Beta Max".to_string(), "viewer".to_string()),
            ("gamma gap".to_string(), "viewer".to_string()),
        ],
        "B floors at Viewer via membership; the accepted viewer share does not widen it"
    );
    let c_labels = label(u_c).await;
    assert_eq!(
        c_labels,
        vec![("gamma gap".to_string(), "editor".to_string())],
        "C reaches exactly the accepted share, at its level"
    );
}

/// TEST-25 (owner-picker + admin aggregates): the instr/lower user picker
/// search and the `SUM(CASE)`-`MAX(a,b)` admin rewrites.
#[tokio::test]
async fn owner_picker_search_and_admin_aggregates_match() {
    let scratch = Scratch::new("project-module-2");
    let merged = compose_sqlite_chain(scratch.path());
    let (pool, _migrator) = apply_chain(&merged, &scratch.path().join("scratch.sqlite")).await;
    let (u_a, _u_b, u_c, _org, p_org, p_shared, _p_beta_max) = seed(&pool).await;

    // --- the owner-picker search (username OR email through instr/lower) ---
    let pick = |needle: Option<&'static str>| {
        let pool = pool.clone();
        async move {
            let rows: Vec<String> = sqlx::query_scalar(
                r#"SELECT username FROM users
                   WHERE ($1 IS NULL
                          OR instr(lower(username), lower($1)) > 0
                          OR instr(lower(email), lower($1)) > 0)
                   ORDER BY username ASC LIMIT $2"#,
            )
            .bind(needle.map(|n| n.to_string()))
            .bind(50i64)
            .fetch_all(&pool)
            .await
            .expect("picker");
            rows
        }
    };
    assert_eq!(pick(Some("ALICE")).await, vec!["alice".to_string()]);
    assert_eq!(pick(Some("example.com")).await.len(), 3, "email match");
    assert_eq!(pick(None).await.len(), 3, "empty query → first limit users");

    // --- the admin aggregates: SUM(CASE) over a no-orphan set is 0; the
    // deactivated owner flips it; the 'orphaned' filter names the project ---
    let orphan_count = || {
        let pool = pool.clone();
        async move {
            let n: i64 = sqlx::query_scalar(
                r#"SELECT COALESCE(SUM(CASE WHEN NOT u.is_active THEN 1 ELSE 0 END), 0)
                   FROM projects s JOIN users u ON u.id = s.owner_id"#,
            )
            .fetch_one(&pool)
            .await
            .expect("orphan count");
            n
        }
    };
    assert_eq!(orphan_count().await, 0, "no orphans → 0, not NULL");
    // All four projects are A-owned (C only holds a share), so deactivating C
    // orphans nothing — the aggregate is per OWNER, not per share.
    sqlx::query("UPDATE users SET is_active = 0 WHERE id = ?")
        .bind(u_c)
        .execute(&pool)
        .await
        .expect("deactivate C");
    assert_eq!(orphan_count().await, 0, "a share recipient is not an owner");
    sqlx::query("UPDATE users SET is_active = 0 WHERE id = ?")
        .bind(u_a)
        .execute(&pool)
        .await
        .expect("deactivate A");
    assert_eq!(
        orphan_count().await,
        4,
        "every project is orphaned with its owner"
    );
    let orphaned: Vec<String> = sqlx::query_scalar(
        "SELECT s.name FROM projects s JOIN users u ON u.id = s.owner_id WHERE NOT u.is_active",
    )
    .fetch_all(&pool)
    .await
    .expect("orphaned");
    assert_eq!(orphaned.len(), 4);
    sqlx::query("UPDATE users SET is_active = 1 WHERE id = ?")
        .bind(u_a)
        .execute(&pool)
        .await
        .expect("reactivate");

    // --- MAX(a,b) last-activity: a project with NO datasets reports its own
    // updated_at (the COALESCE fallback) and sorts after a touched one ------
    sqlx::query("UPDATE projects SET updated_at = '2099-01-01T00:00:00.000Z' WHERE id = ?")
        .bind(p_org)
        .execute(&pool)
        .await
        .expect("touch");
    let rows: Vec<(String, String)> = sqlx::query_as(
        r#"SELECT s.name,
                  MAX(s.updated_at,
                    COALESCE((SELECT MAX(d.updated_at) FROM datasets d
                                JOIN project_datasets sd ON sd.dataset_id = d.id
                               WHERE sd.project_id = s.id), s.updated_at))
           FROM projects s
           WHERE s.id IN (?, ?)
           ORDER BY 2 DESC"#,
    )
    .bind(p_org)
    .bind(p_shared)
    .fetch_all(&pool)
    .await
    .expect("last activity");
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].0, "Alpha Beta", "the touched project is the newest");
    assert_eq!(rows[0].1, "2099-01-01T00:00:00.000Z");
}

/// TEST-25 (transfer + settings): the pending-unique race code, the
/// `DELETE … WHERE id IN (…)` RETURNING port and the singleton upsert.
#[tokio::test]
async fn transfer_race_cancel_and_settings_singleton_hold() {
    let scratch = Scratch::new("project-module-3");
    let merged = compose_sqlite_chain(scratch.path());
    let (pool, _migrator) = apply_chain(&merged, &scratch.path().join("scratch.sqlite")).await;
    let (u_a, u_b, _u_c, org, p_org, _p_shared, _p_beta_max) = seed(&pool).await;

    // --- one pending transfer per project: the race is the extended code
    // `2067` the repository's 409 TRANSFER_PENDING mapping matches ----------
    let t = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO project_transfers (id, project_id, from_user_id, to_user_id, status) \
         VALUES (?, ?, ?, ?, 'pending')",
    )
    .bind(t)
    .bind(p_org)
    .bind(u_a)
    .bind(u_b)
    .execute(&pool)
    .await
    .expect("first transfer");
    let err = sqlx::query(
        "INSERT INTO project_transfers (id, project_id, from_user_id, to_user_id, status) \
         VALUES (?, ?, ?, ?, 'pending')",
    )
    .bind(Uuid::new_v4())
    .bind(p_org)
    .bind(u_a)
    .bind(u_b)
    .execute(&pool)
    .await
    .expect_err("second pending refused");
    assert_eq!(
        err.as_database_error().unwrap().code().as_deref(),
        Some("2067"),
        "SQLITE_CONSTRAINT_UNIQUE extended code (the 23505 → 2067 map)"
    );

    // --- the DELETE … USING port: cancel BOTH directions of a departing
    // member, RETURNING the cancelled rows ---------------------------------
    let cancelled: Vec<(Uuid,)> = sqlx::query_as(
        r#"DELETE FROM project_transfers
            WHERE id IN (SELECT t.id FROM project_transfers t
                          JOIN projects p ON p.id = t.project_id
                         WHERE t.status = 'pending'
                           AND p.account_id = ?
                           AND (t.from_user_id = ? OR t.to_user_id = ?))
         RETURNING id"#,
    )
    .bind(org)
    .bind(u_b)
    .bind(u_b)
    .fetch_all(&pool)
    .await
    .expect("cancel");
    assert_eq!(
        cancelled,
        vec![(t,)],
        "the departing member's pending transfer is cancelled"
    );

    // --- project_settings singleton: ON CONFLICT upsert never widens -------
    sqlx::query(
        "INSERT INTO project_settings (singleton, transfer_enabled, updated_at) \
         VALUES (true, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) \
         ON CONFLICT (singleton) DO UPDATE SET \
           transfer_enabled = EXCLUDED.transfer_enabled, \
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
    )
    .bind(false)
    .execute(&pool)
    .await
    .expect("settings upsert");
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM project_settings")
        .fetch_one(&pool)
        .await
        .expect("settings count");
    assert_eq!(n, 1, "singleton stays one row");
    let enabled: bool = sqlx::query_scalar("SELECT transfer_enabled FROM project_settings")
        .fetch_one(&pool)
        .await
        .expect("settings value");
    assert!(!enabled, "the upserted value round-trips as bool");
}
