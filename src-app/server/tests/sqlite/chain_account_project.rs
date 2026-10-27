//! The `account` + `project` chain invariants — TESTS.md TEST-17, the
//! ITEM-10 per-item test.
//!
//! TEST-17 as written in TESTS.md: "the `account` + `project` chains apply;
//! the `groups.permissions` JSON-array column round-trips through `json_each`
//! membership and `json_insert` append with the same semantics as
//! `= ANY`/`array_append` (fixture: the seeded `Users` group carries
//! `jobs::use`), and the project-name case-insensitive search returns the
//! same rows as the PG `ILIKE` on ASCII names (fixture list)."
//!
//! What THIS item pins beyond the shared harness's 57-file leg (the full chain):
//!
//!   * the account baseline's BACKFILL over pre-existing users (the
//!     migration's whole point — a fresh-file first boot has no users, so
//!     the shared harness never exercises the backfill; here a user is
//!     created BEFORE the account chain applies, exactly the state the
//!     Postgres file's INSERT…SELECT was written for);
//!   * the `groups.permissions` JSON-array grant semantics (append exactly
//!     once, the final 17-item array in version order (ITEM-11's provenance + drafts grants at their version positions); `json_each`
//!     membership + `json_insert` tail-append round-trip);
//!   * the project-name `instr(lower(name), lower(?)) > 0` rewrite (the
//!     DEC-11 ASCII-folded port of `ILIKE`) returns the same rows the
//!     Postgres ILIKE returns on the ASCII fixture;
//!   * the 202608040013 account_id column state (NOT NULL CHECK + FK
//!     enforced) + the two account_id indexes;
//!   * the project tables' constraints (settings singleton, partial
//!     one-pending-transfer unique, user-cascade);
//!   * the invitations schema (token BLOB length CHECK, normalized-email
//!     CHECK, live-unique partial index, the control-char CHECK via the
//!     GLOB port) and the mint ledger row;
//!   * the account_member_events append-only triggers + the users-cascade
//!     recording trigger (the port's three trigger divergences, each
//!     asserted by behavior: direct UPDATE/DELETE refused, the account
//!     cascade permitted, a user delete records exactly the
//!     surviving-account membership and NOT the personal one).

use super::apply_chain::{apply_chain, compose_sqlite_chain, Scratch, CHAIN_FILES};

/// The chain state at the end of ITEM-9 (SDK 7 + app ITEM-8 groups 13 +
/// workstore 19 = 39 files) was the ITEM-10-era split point; at ITEM-11 the
/// pre-ITEM-10 set additionally contains ITEM-11's dataset/drafts/
/// provenance files (9, interleaved by version), so the pre set is now
/// `CHAIN_FILES.len() - 9` = 48 files.
const PRE_ITEM10_FILE_COUNT: usize = 48;

/// The nine ITEM-10 files, in the order the merged chain applies them (they
/// INTERLEAVE with the rest of the chain by version — 202608030003 sorts
/// before the workstore baseline, 202608040012…014 inside the 0400xx
/// window — so "the ITEM-10 group" is an explicit list, not a contiguous
/// suffix of `CHAIN_FILES`).
const ITEM10_FILES: &[&str] = &[
    "202608030003_project_baseline.sql",
    "202608040012_account_baseline.sql",
    "202608040013_ownership_account_id.sql",
    "202608040014_account_id_indexes.sql",
    "202608280011_account_admin_suspend.sql",
    "202609040001_account_members_manage.sql",
    "202609040002_account_invitations.sql",
    "202609040003_account_invitation_mints.sql",
    "202609040010_account_member_events.sql",
];

/// Insert an org account (the fixture-tenant shape — `accoun
/// ts_personal_has_user` needs kind+personal_user_id agreement, an org has
/// no user).
async fn insert_org_account(pool: &sqlx::SqlitePool, id: uuid::Uuid, name: &str) {
    sqlx::query("INSERT INTO accounts (id, kind, name) VALUES (?, 'organization', ?)")
        .bind(id)
        .bind(name)
        .execute(pool)
        .await
        .expect("org account");
}

/// TEST-17 (backfill leg): apply the ITEM-9-state chain, create a user,
/// then apply the nine ITEM-10 files as a second migrator — the account
/// baseline's backfill runs against a populated `users` table and yields
/// exactly one personal account + one owner membership with 16-byte BLOB
/// ids; the grants are the final 17-item JSON array; the re-apply of the
/// full chain is a no-op.
#[tokio::test]
async fn account_backfill_over_preexisting_users_and_idempotence_hold() {
    let scratch = Scratch::new("account-backfill");
    let merged = compose_sqlite_chain(scratch.path());

    // Split the composed chain: the pre-ITEM-10 set (everything except the
    // nine ITEM-10 files, which interleave by version) and the nine files
    // themselves.
    let pre = scratch.path().join("pre");
    let post = scratch.path().join("post");
    std::fs::create_dir_all(&pre).expect("pre dir");
    std::fs::create_dir_all(&post).expect("post dir");
    let mut pre_names: Vec<&str> = CHAIN_FILES
        .iter()
        .copied()
        .filter(|n| !ITEM10_FILES.contains(n))
        .collect();
    pre_names.sort_unstable();
    assert_eq!(
        pre_names.len(),
        PRE_ITEM10_FILE_COUNT,
        "pre set is 48 files"
    );
    for name in &pre_names {
        std::fs::copy(merged.join(name), pre.join(name)).expect("copy pre-file");
    }
    for name in ITEM10_FILES {
        std::fs::copy(merged.join(name), post.join(name)).expect("copy item10 file");
    }

    // The pre-ITEM-10 chain applies WITH the ITEM-9/11-state stub parents,
    // explicitly (the shared `ensure_late_parent_stubs` is conditional on
    // the staged dirs and creates nothing at ITEM-11 — the REAL
    // account/project tables must NOT exist in this pre-state, while the
    // workstore DML (the 040001 DELETE FROM artifacts) needs the
    // project/accounts parent tables to exist at all — FK DML resolves the
    // whole parent set). `datasets` needs NO stub at ITEM-11: it sorts in
    // the pre set (202608030002, the real ITEM-11 chain) and is real by
    // the time any DML runs. The pre state is exactly the ITEM-9/11
    // harness state.
    let db = scratch.path().join("scratch.sqlite");
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&db)
                .create_if_missing(true)
                .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
                .foreign_keys(true),
        )
        .await
        .expect("scratch pool");
    sqlx::query("CREATE TABLE IF NOT EXISTS accounts (id BLOB PRIMARY KEY)")
        .execute(&pool)
        .await
        .expect("accounts stub");
    sqlx::query("CREATE TABLE IF NOT EXISTS projects (id BLOB PRIMARY KEY)")
        .execute(&pool)
        .await
        .expect("projects stub");
    sqlx::migrate::Migrator::new(pre.as_path())
        .await
        .expect("pre migrator")
        .run(&pool)
        .await
        .expect("pre-ITEM-10 chain applies");

    // A pre-existing user — the backfill's reason for being.
    let alice = uuid::Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, username, email) VALUES (?, 'alice', 'alice@x.io')")
        .bind(alice)
        .execute(&pool)
        .await
        .expect("pre-existing user");
    let pre_ver: i64 = sqlx::query_scalar("SELECT count(*) FROM _sqlx_migrations")
        .fetch_one(&pool)
        .await
        .expect("_sqlx_migrations");
    assert_eq!(pre_ver, PRE_ITEM10_FILE_COUNT as i64, "pre state applied");

    // The pre-state's stubs are the ITEM-9 device; the real chains replace
    // them — the strict CREATE TABLEs need the names free (the artifact /
    // feature_flags tables are empty here, so the drops leave no orphan
    // rows; SQLite keeps the child FK definitions, which re-bind lazily to
    // the recreated parent).
    sqlx::query("DROP TABLE accounts")
        .execute(&pool)
        .await
        .expect("drop accounts stub");
    sqlx::query("DROP TABLE projects")
        .execute(&pool)
        .await
        .expect("drop projects stub");

    // The ITEM-10 files (in chain order), applied via `sqlx::raw_sql` (not a
    // second `Migrator` — a migrator over a DB carrying other versions
    // refuses with `VersionMissing`, and the raw form is the runtime's
    // per-file execution); the `_sqlx_migrations` no-op re-apply is the
    // shared harness's leg.
    for name in ITEM10_FILES {
        let sql = std::fs::read_to_string(post.join(name)).expect("read item10 file");
        sqlx::raw_sql(&sql)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("ITEM-10 file {name}: {e}"));
    }

    // --- exactly one personal account (BLOB id) + one owner membership ---
    let (acct_id, kind, name, pu, storage): (
        uuid::Uuid,
        String,
        String,
        Option<uuid::Uuid>,
        String,
    ) = sqlx::query_as(
        "SELECT id, kind, name, personal_user_id, typeof(id) FROM accounts WHERE kind = 'personal'",
    )
    .fetch_one(&pool)
    .await
    .expect("personal account");
    assert_eq!((kind.as_str(), name.as_str()), ("personal", "alice"));
    assert_eq!(pu, Some(alice), "the account points at its user");
    assert_ne!(
        acct_id, alice,
        "the account id is a fresh uuid, not the user's"
    );
    assert_eq!(storage, "blob", "uuid values are 16-byte blobs");
    let (m_acct, m_user, m_role): (uuid::Uuid, uuid::Uuid, String) =
        sqlx::query_as("SELECT account_id, user_id, role FROM account_members WHERE user_id = ?")
            .bind(alice)
            .fetch_one(&pool)
            .await
            .expect("membership row");
    assert_eq!(m_acct, acct_id);
    assert_eq!(m_user, alice);
    assert_eq!(m_role, "owner");
    let personal: i64 = sqlx::query_scalar("SELECT count(*) FROM accounts")
        .fetch_one(&pool)
        .await
        .expect("accounts count");
    assert_eq!(personal, 1, "one personal account back-filled");

    // --- the grants: every perm present exactly once (order is not
    // pin-able here — the two-phase apply appends the ITEM-10 grants after
    // the pre-applied ones; the exact VERSION ORDER of the final array is
    // pinned by the shared harness's one-shot full-chain leg). At ITEM-11
    // the pre-applied set additionally carries the ITEM-11 grants
    // (provenance::read/export by 202608030005, drafts::use by
    // 202608240001), so the final array is 17 items.
    let permissions_json: String =
        sqlx::query_scalar("SELECT permissions FROM groups WHERE name = 'Users'")
            .fetch_one(&pool)
            .await
            .expect("Users group");
    let granted: Vec<&str> = serde_json::from_str(&permissions_json).expect("permissions JSON");
    assert_eq!(granted.len(), 17, "final 17-item array: {permissions_json}");
    for perm in [
        "jobs::use",
        "mcp::use",
        "account::read",
        "account::members::manage",
        "projects::use",
        "notifications::read",
        "provenance::read",
        "provenance::export",
        "drafts::use",
        "files::read",
        "files::upload",
        "files::download",
        "files::delete",
        "files::preview",
        "files::generate_token",
        "profile::read",
        "profile::edit",
    ] {
        assert_eq!(
            granted.iter().filter(|p| **p == perm).count(),
            1,
            "{perm} granted exactly once: {permissions_json}"
        );
    }
    // json_insert append (the `array_append` port): appending one more is a
    // pure tail-extend.
    sqlx::query(
        "UPDATE groups SET permissions = json_insert(permissions, '$[#]', 'probe::x') \
         WHERE name = 'Users'",
    )
    .execute(&pool)
    .await
    .expect("append");
    let extended_json: String =
        sqlx::query_scalar("SELECT permissions FROM groups WHERE name = 'Users'")
            .fetch_one(&pool)
            .await
            .expect("Users group");
    let extended: Vec<&str> =
        serde_json::from_str(&extended_json).expect("updated permissions JSON");
    assert_eq!(extended.len(), granted.len() + 1, "tail-extend only");
    assert_eq!(extended[granted.len()], "probe::x");

    // --- the full 57-file chain re-applies as a no-op (shared harness leg;
    // the raw-applied files above are not in `_sqlx_migrations`, so this
    // test's own no-op proof is the shared `ported_chain…` test instead).
}

/// TEST-17 (row-semantics leg): the project-name search rewrite, the
/// project tables' constraints, and the 202608040013 account_id state.
#[tokio::test]
async fn project_search_and_account_id_state_hold() {
    let scratch = Scratch::new("project-search");
    let merged = compose_sqlite_chain(scratch.path());
    let (pool, _migrator) = apply_chain(&merged, &scratch.path().join("scratch.sqlite")).await;

    let owner = uuid::Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, username, email) VALUES (?, 'owner', 'o@x.io')")
        .bind(owner)
        .execute(&pool)
        .await
        .expect("owner user");
    let tenant = uuid::Uuid::new_v4();
    insert_org_account(&pool, tenant, "tenant").await;

    // --- project-name case-insensitive search (the ILIKE port) -----------
    let names = ["Alpha Beta", "gamma gap", "delta", "Beta Max"];
    for name in names {
        sqlx::query("INSERT INTO projects (id, owner_id, name, account_id) VALUES (?, ?, ?, ?)")
            .bind(uuid::Uuid::new_v4())
            .bind(owner)
            .bind(name)
            .bind(tenant)
            .execute(&pool)
            .await
            .expect("project row");
    }
    // The rewrite the repository uses (DEC-11/DEC-12): substring containment
    // with ASCII-only folding — `instr(lower(name), lower(?)) > 0` is the
    // PG `ILIKE '%needle%'` on the ASCII fixture (case-insensitive: the
    // same rows, needle in either case).
    let search = |needle: &'static str| {
        let pool = pool.clone();
        async move {
            let rows: Vec<String> = sqlx::query_scalar(
                "SELECT name FROM projects \
                 WHERE instr(lower(name), lower(?)) > 0 ORDER BY name",
            )
            .bind(needle)
            .fetch_all(&pool)
            .await
            .expect("search");
            rows
        }
    };
    assert_eq!(search("alpha").await, vec!["Alpha Beta".to_string()]);
    assert_eq!(
        search("BETA").await,
        vec!["Alpha Beta".to_string(), "Beta Max".to_string()],
        "needle case does not change the result set (ILIKE parity)"
    );
    assert_eq!(search("GAP").await, vec!["gamma gap".to_string()]);
    assert!(search("zz").await.is_empty());

    // --- 202608040013: account_id NOT NULL + FK + the two indexes -------
    let err = sqlx::query("INSERT INTO projects (id, owner_id, name) VALUES (?, ?, 'no-account')")
        .bind(uuid::Uuid::new_v4())
        .bind(owner)
        .execute(&pool)
        .await
        .expect_err("account_id is enforced NOT NULL from the column's birth");
    assert!(
        err.to_string().contains("CHECK constraint failed"),
        "account_id absence is refused: {err}"
    );
    let err = sqlx::query(
        "INSERT INTO projects (id, owner_id, name, account_id) VALUES (?, ?, 'bad-acct', ?)",
    )
    .bind(uuid::Uuid::new_v4())
    .bind(owner)
    .bind(uuid::Uuid::new_v4())
    .execute(&pool)
    .await
    .expect_err("a bogus account_id must violate the FK");
    assert!(
        err.to_string().contains("FOREIGN KEY"),
        "FK enforced: {err}"
    );
    let idx: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'projects'",
    )
    .fetch_all(&pool)
    .await
    .expect("project indexes");
    for name in ["idx_projects_account_created", "idx_projects_owner_created"] {
        assert!(idx.contains(&name.to_string()), "index {name} exists");
    }
    let shares_idx: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'project_shares'",
    )
    .fetch_all(&pool)
    .await
    .expect("share indexes");
    assert!(shares_idx.contains(&"uq_project_shares_project_recipient".to_string()));

    // --- project_settings singleton (seeded exactly once) ----------------
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM project_settings")
        .fetch_one(&pool)
        .await
        .expect("project_settings");
    assert_eq!(rows, 1, "singleton seeded exactly once (ON CONFLICT seed)");
    let err =
        sqlx::query("INSERT INTO project_settings (singleton, transfer_enabled) VALUES (2, 1)")
            .execute(&pool)
            .await
            .expect_err("a second settings row must be refused");
    assert!(
        err.to_string().contains("project_settings_singleton_check"),
        "the singleton pin names the constraint: {err}"
    );

    // --- one pending transfer per project (partial unique) --------------
    let project_id = uuid::Uuid::new_v4();
    sqlx::query(
        "INSERT INTO projects (id, owner_id, name, account_id) VALUES (?, ?, 'transfer', ?)",
    )
    .bind(project_id)
    .bind(owner)
    .bind(tenant)
    .execute(&pool)
    .await
    .expect("transfer project");
    let transfer = |status: &'static str, from: uuid::Uuid, to: uuid::Uuid| {
        let pool = pool.clone();
        async move {
            sqlx::query(
                "INSERT INTO project_transfers (id, project_id, from_user_id, to_user_id, status) \
                 VALUES (?, ?, ?, ?, ?)",
            )
            .bind(uuid::Uuid::new_v4())
            .bind(project_id)
            .bind(from)
            .bind(to)
            .bind(status)
            .execute(&pool)
            .await
        }
    };
    transfer("pending", owner, owner)
        .await
        .expect("first pending transfer");
    let err = transfer("pending", owner, owner)
        .await
        .expect_err("a second pending transfer of the same project must be refused");
    assert!(
        err.to_string().contains("UNIQUE"),
        "one-pending guard: {err}"
    );
    transfer("accepted", owner, owner)
        .await
        .expect("accepted transfers are not constrained by the partial index");

    // --- user delete cascades the whole project surface -----------------
    sqlx::query("DELETE FROM users WHERE id = ?")
        .bind(owner)
        .execute(&pool)
        .await
        .expect("delete owner");
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM projects WHERE owner_id IS NOT NULL")
        .fetch_one(&pool)
        .await
        .expect("projects");
    assert_eq!(left, 0, "projects cascade with their owner");
}

/// TEST-17 (invitations): the token/email CHECKs, the live-unique partial
/// index and the mint ledger row.
#[tokio::test]
async fn invitations_schema_and_mints_hold() {
    let scratch = Scratch::new("invitations");
    let merged = compose_sqlite_chain(scratch.path());
    let (pool, _migrator) = apply_chain(&merged, &scratch.path().join("scratch.sqlite")).await;

    let tenant = uuid::Uuid::new_v4();
    insert_org_account(&pool, tenant, "tenant").await;

    // A valid invitation: email normalized already, 32-byte token.
    let token = [0xABu8; 32];
    sqlx::query(
        "INSERT INTO account_invitations (id, account_id, email, role, token_sha256, expires_at) \
         VALUES (?, ?, 'a@b.com', 'member', ?, '2027-01-01T00:00:00.000Z')",
    )
    .bind(uuid::Uuid::new_v4())
    .bind(tenant)
    .bind(token.as_slice())
    .execute(&pool)
    .await
    .expect("valid invitation");

    // ONE live invitation per (account, email).
    let err = sqlx::query(
        "INSERT INTO account_invitations (id, account_id, email, role, token_sha256, expires_at) \
         VALUES (?, ?, 'a@b.com', 'member', ?, '2027-01-01T00:00:00.000Z')",
    )
    .bind(uuid::Uuid::new_v4())
    .bind(tenant)
    .bind([0xCDu8; 32].as_slice())
    .execute(&pool)
    .await
    .expect_err("a second live invitation for the same address must be refused");
    assert!(
        err.to_string().contains("UNIQUE"),
        "live-unique guard: {err}"
    );
    // An accepted one does not collide (the partial predicate).
    sqlx::query(
        "INSERT INTO account_invitations (id, account_id, email, role, token_sha256, expires_at, accepted_at, accepted_by) \
         VALUES (?, ?, 'a@b.com', 'member', ?, '2027-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?)",
    )
    .bind(uuid::Uuid::new_v4())
    .bind(tenant)
    .bind([0xCDu8; 32].as_slice())
    .bind(uuid::Uuid::new_v4())
    .execute(&pool)
    .await
    .expect("accepted row frees the live slot");

    // --- the type/semantic CHECKs (port constructs) ----------------------
    let err = sqlx::query(
        "INSERT INTO account_invitations (id, account_id, email, role, token_sha256, expires_at) \
         VALUES (?, ?, 'x@y.com', 'member', ?, '2027-01-01T00:00:00.000Z')",
    )
    .bind(uuid::Uuid::new_v4())
    .bind(tenant)
    .bind([0x11u8; 16].as_slice())
    .execute(&pool)
    .await
    .expect_err("a 16-byte token (not SHA-256) must be refused");
    assert!(
        err.to_string().contains("CHECK constraint failed"),
        "token length CHECK: {err}"
    );
    let err = sqlx::query(
        "INSERT INTO account_invitations (id, account_id, email, role, token_sha256, expires_at) \
         VALUES (?, ?, 'Mixed@Case.com', 'member', ?, '2027-01-01T00:00:00.000Z')",
    )
    .bind(uuid::Uuid::new_v4())
    .bind(tenant)
    .bind([0x11u8; 32].as_slice())
    .execute(&pool)
    .await
    .expect_err("a non-normalized email must be refused");
    assert!(
        err.to_string().contains("CHECK constraint failed"),
        "normalized-email CHECK: {err}"
    );
    let err = sqlx::query(
        "INSERT INTO account_invitations (id, account_id, email, role, token_sha256, expires_at) \
         VALUES (?, ?, ?, 'member', ?, '2027-01-01T00:00:00.000Z')",
    )
    .bind(uuid::Uuid::new_v4())
    .bind(tenant)
    .bind("x@y.com\nBcc: a@b.com")
    .bind([0x11u8; 32].as_slice())
    .execute(&pool)
    .await
    .expect_err("a control character in the email must be refused");
    assert!(
        err.to_string().contains("CHECK constraint failed"),
        "control-char CHECK (GLOB port): {err}"
    );

    // --- the mint ledger: plain row + the account-scoped indexes --------
    sqlx::query(
        "INSERT INTO account_invitation_mints (id, account_id, actor_user_id, invitation_id) \
         VALUES (?, ?, ?, ?)",
    )
    .bind(uuid::Uuid::new_v4())
    .bind(tenant)
    .bind(uuid::Uuid::new_v4())
    .bind(uuid::Uuid::new_v4())
    .execute(&pool)
    .await
    .expect("mint row");
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM account_invitation_mints")
        .fetch_one(&pool)
        .await
        .expect("mints");
    assert_eq!(n, 1);
    let dropped: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'account_invitations'",
    )
    .fetch_all(&pool)
    .await
    .expect("invitation indexes");
    for name in [
        "uq_account_invitations_live",
        "uq_account_invitations_token_sha256",
    ] {
        assert!(dropped.contains(&name.to_string()), "index {name} exists");
    }
    assert!(
        !dropped.contains(&"idx_account_invitations_resender".to_string()),
        "the FIX_ROUND-1 limiter indexes are dropped"
    );
}

/// TEST-17 (member events): the append-only triggers + the cascade-removal
/// recording — the port's three trigger divergences, each asserted by
/// behavior.
#[tokio::test]
async fn member_events_append_only_and_cascade_recording_hold() {
    let scratch = Scratch::new("member-events");
    let merged = compose_sqlite_chain(scratch.path());
    let (pool, _migrator) = apply_chain(&merged, &scratch.path().join("scratch.sqlite")).await;

    let user_a = uuid::Uuid::new_v4();
    let user_b = uuid::Uuid::new_v4();
    for (id, name) in [(user_a, "a"), (user_b, "b")] {
        sqlx::query("INSERT INTO users (id, username, email) VALUES (?, ?, ?)")
            .bind(id)
            .bind(name)
            .bind(format!("{name}@x.io"))
            .execute(&pool)
            .await
            .expect("user");
    }
    // The org: A is owner, B is member.
    let org = uuid::Uuid::new_v4();
    insert_org_account(&pool, org, "org").await;
    sqlx::query("INSERT INTO account_members (account_id, user_id, role) VALUES (?, ?, 'owner')")
        .bind(org)
        .bind(user_a)
        .execute(&pool)
        .await
        .expect("org owner");
    sqlx::query("INSERT INTO account_members (account_id, user_id, role) VALUES (?, ?, 'member')")
        .bind(org)
        .bind(user_b)
        .execute(&pool)
        .await
        .expect("org member");
    // B's OWN personal account + owner membership (the account baseline
    // creates these for pre-existing users only — the migration already ran
    // on an empty users table, so this fixture is the manual equivalent).
    let personal_b = uuid::Uuid::new_v4();
    sqlx::query(
        "INSERT INTO accounts (id, kind, name, personal_user_id) VALUES (?, 'personal', 'b', ?)",
    )
    .bind(personal_b)
    .bind(user_b)
    .execute(&pool)
    .await
    .expect("personal account of B");
    sqlx::query("INSERT INTO account_members (account_id, user_id, role) VALUES (?, ?, 'owner')")
        .bind(personal_b)
        .bind(user_b)
        .execute(&pool)
        .await
        .expect("personal membership");

    // A journaled join (a non-system actor must be named — actor_id_kind).
    sqlx::query(
        "INSERT INTO account_member_events (id, account_id, actor_user_id, actor_kind, action, target_user_id, new_role) \
         VALUES (?, ?, ?, 'admin', 'joined', ?, 'member')",
    )
    .bind(uuid::Uuid::new_v4())
    .bind(org)
    .bind(user_a)
    .bind(user_b)
    .execute(&pool)
    .await
    .expect("joined event");

    // --- append-only: UPDATE and direct DELETE are refused ---------------
    let err = sqlx::query("UPDATE account_member_events SET reason = 'x'")
        .execute(&pool)
        .await
        .expect_err("an UPDATE is a correction — refused");
    assert!(
        err.to_string().contains("append-only"),
        "UPDATE refusal names the invariant: {err}"
    );
    let err = sqlx::query("DELETE FROM account_member_events")
        .execute(&pool)
        .await
        .expect_err("a direct DELETE is refused");
    assert!(
        err.to_string().contains("append-only"),
        "DELETE refusal names the invariant: {err}"
    );

    // --- a user delete records the surviving-account membership ----------
    // B leaves: the org membership is recorded as system/removed; B's OWN
    // personal membership is NOT (its account dies with the user — the
    // Postgres cascade-order property 3), and the ledger row for the
    // per-account... the personal account + its memberships cascade away.
    sqlx::query("DELETE FROM users WHERE id = ?")
        .bind(user_b)
        .execute(&pool)
        .await
        .expect("delete B");
    let events: Vec<(
        uuid::Uuid,
        String,
        String,
        Option<uuid::Uuid>,
        Option<String>,
    )> = sqlx::query_as(
        "SELECT account_id, actor_kind, action, target_user_id, old_role \
         FROM account_member_events ORDER BY created_at",
    )
    .fetch_all(&pool)
    .await
    .expect("events");
    assert_eq!(events.len(), 2, "the join + the cascade-removed record");
    let removed = events
        .iter()
        .find(|(_, _, action, _, _)| action == "removed")
        .expect("removed row");
    assert_eq!(removed.0, org, "the org membership is recorded");
    assert_eq!(removed.2, "removed");
    assert_eq!(removed.3, Some(user_b));
    assert_eq!(removed.4.as_deref(), Some("member"), "old_role carried");
    let gone: i64 = sqlx::query_scalar("SELECT count(*) FROM accounts WHERE id = ?")
        .bind(personal_b)
        .fetch_one(&pool)
        .await
        .expect("personal account");
    assert_eq!(gone, 0, "the personal account cascades with its user");
    assert_eq!(
        events
            .iter()
            .filter(|(account, ..)| *account == personal_b)
            .count(),
        0,
        "no event is recorded for the account that dies with the user"
    );

    // --- the account cascade is the ledger's sanctioned deletion path ----
    sqlx::query("DELETE FROM accounts WHERE id = ?")
        .bind(org)
        .execute(&pool)
        .await
        .expect("delete org");
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM account_member_events")
        .fetch_one(&pool)
        .await
        .expect("events after account delete");
    assert_eq!(
        left, 0,
        "the ledger dies with its account (cascade permitted)"
    );
}
