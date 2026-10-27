//! `users.email` is stored lowercased, and that is a DATABASE INVARIANT.
//!
//! ── the hole this file exists to close (#251) ───────────────────────────────
//!
//! `users_email_key` is `UNIQUE (email)` — byte-exact, so `bob@corp.com` and
//! `BOB@CORP.COM` were two DISTINCT principals. `POST /api/auth/register` is
//! open self-registration, so anyone holding a leaked invitation link for
//! `bob@corp.com` could register the case variant and satisfy the accept
//! path's `lower(trim(users.email)) == invitation.email` binding — a total
//! bypass of the recipient control, not a weakening of it.
//!
//! The fix is deliberately NOT a functional unique index: the whole point is
//! that no index NAME is reserved, so there is nothing for an error-attribution
//! mapper to mis-match on (#283) and nothing for an under-qualified
//! `DROP INDEX` to destroy on a foreign table (#284). Instead:
//!
//!   1. every write path lowercases in Rust (`auth::email::normalize_email`),
//!   2. `202609090010` makes that an invariant with `CHECK (email = lower(email))`,
//!   3. the pre-existing plain `UNIQUE (email)` does the rest — on normalised
//!      data it IS case-insensitive uniqueness.
//!
//! ── the Unicode seam (#260) ─────────────────────────────────────────────────
//!
//! Rust's `to_lowercase` and Postgres's `lower` disagree on 56 code points, so
//! a Rust-lowered value could fail a Postgres CHECK (→ a 500 on a shipped
//! path). Over printable ASCII the two folds agree EXACTLY, so the ASCII
//! restriction is load-bearing rather than incidental — and this file asserts
//! it at every write path.

mod common;

use std::sync::Arc;

use axum::Extension;
use axum::Json;
use axum::http::{HeaderMap, StatusCode};
use common::{SEEDED_PROVIDER_ID, drop_db, fresh_db};
use sqlx::{Executor, Row};
use ziee_core::DbPool;
use uuid::Uuid;
use ziee_auth::auth::http::handlers::register;
use ziee_auth::auth::jwt::{JwtService, JwtSettings};
use ziee_auth::auth::types::RegisterRequest;
use ziee_auth::auth::hash_password;
use ziee_auth::auth::providers::AuthProviderTrait;
use ziee_auth::auth::providers::local::LocalAuthProvider;
use ziee_auth::auth::providers::models::AuthProvider;
use ziee_auth::auth::{AuthContext, AuthRepository, NoopAuthEventSink, NoopAuthSyncSink};
use ziee_auth::user::UserRepository;

fn provider_id() -> Uuid {
    Uuid::parse_str(SEEDED_PROVIDER_ID).unwrap()
}

/// The `local` provider row `LocalAuthProvider::new` reads its name/config
/// from. Built here rather than fetched because the seed ships only the three
/// OAuth providers.
fn local_provider_row() -> AuthProvider {
    AuthProvider {
        id: Uuid::new_v4(),
        name: "local".to_string(),
        provider_type: "local".to_string(),
        enabled: true,
        config: serde_json::json!({}),
        created_at: chrono::Utc::now(),
        updated_at: chrono::Utc::now(),
        last_test_at: None,
        last_test_ok: None,
        last_test_message: None,
    }
}

fn jwt() -> Arc<JwtService> {
    Arc::new(
        JwtService::try_new(JwtSettings {
            secret: "0123456789abcdef0123456789abcdef-strong".to_string(),
            issuer: "test".to_string(),
            audience: "test".to_string(),
            access_token_expiry_hours: 24,
            refresh_token_expiry_days: 30,
            access_token_expiry_seconds: None,
        })
        .expect("test jwt secret is strong enough"),
    )
}

fn ctx(pool: &DbPool) -> AuthContext {
    AuthContext::new(
        Arc::new(pool.clone()),
        None,
        Arc::new(NoopAuthEventSink),
        Arc::new(NoopAuthSyncSink),
    )
}

const PASSWORD: &str = "S3cret-password!42";

/// Drive the real `POST /api/auth/register` handler and return the status the
/// client would see. `ApiResult`'s error arm carries the status the handler
/// chose, which is what `IntoResponse` turns into the wire status.
async fn post_register(pool: &DbPool, username: &str, email: &str) -> (StatusCode, Option<String>) {
    let req = RegisterRequest {
        username: username.to_string(),
        email: email.to_string(),
        password: PASSWORD.to_string(),
        display_name: None,
    };
    match register(Extension(jwt()), Extension(ctx(pool)), HeaderMap::new(), Json(req)).await {
        Ok((status, _resp)) => (status, None),
        Err((status, err)) => (status, Some(err.error_code().to_string())),
    }
}

/// Every stored address, sorted in RUST (byte order) — the database's own
/// `ORDER BY` is collation-dependent, and this file is about case, so the
/// ordering must not be.
async fn emails_in(pool: &DbPool) -> Vec<String> {
    let mut v: Vec<String> = sqlx::query("SELECT email FROM users")
        .fetch_all(pool)
        .await
        .unwrap()
        .into_iter()
        .map(|r| r.get::<String, _>("email"))
        .collect();
    v.sort();
    v
}

// ───────────────────────────────────────────────────────────────────────────
// 1. The exploit itself, at the route that is exposed to the internet.
// ───────────────────────────────────────────────────────────────────────────

/// THE #251 EXPLOIT. Registering a CASE VARIANT of an address that is already
/// held must be refused with the same generic `ACCOUNT_EXISTS` 409 an exact
/// duplicate gets — not accepted as a second principal.
///
/// Before the fix this asserted `201 CREATED`, because that is what the shipped
/// code did: the second principal was created and could redeem an invitation
/// issued to the first one's address.
#[tokio::test]
async fn registering_a_case_variant_of_a_held_address_is_a_conflict_not_a_second_principal() {
    let (pool, db) = fresh_db().await;

    let (first, _) = post_register(&pool, "bob", "bob@corp.com").await;
    assert_eq!(first, StatusCode::CREATED, "the legitimate signup must work");

    let (second, code) = post_register(&pool, "mallory", "BOB@CORP.COM").await;
    assert_eq!(
        second,
        StatusCode::CONFLICT,
        "a case variant of a held address must be refused; a 201 here is #251 — \
         two principals for one mailbox, either of which satisfies an invitation \
         binding issued to that address"
    );
    assert_eq!(
        code.as_deref(),
        Some("ACCOUNT_EXISTS"),
        "the refusal must reuse the generic collapse so it stays enumeration-safe \
         (it must not say WHICH of username/email collided)"
    );

    assert_eq!(
        emails_in(&pool).await,
        vec!["bob@corp.com".to_string()],
        "exactly one principal may hold the address"
    );

    drop_db(&db).await;
}

/// The stored form is the normalised one, whatever case the client sent — so
/// the address the invitation binding compares against is canonical.
#[tokio::test]
async fn register_stores_the_normalised_address() {
    let (pool, db) = fresh_db().await;

    let (status, _) = post_register(&pool, "carol", "  CaRoL@Corp.COM  ").await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(emails_in(&pool).await, vec!["carol@corp.com".to_string()]);

    drop_db(&db).await;
}

// ───────────────────────────────────────────────────────────────────────────
// 2. The invariant is the DATABASE's, not a convention the writers observe.
// ───────────────────────────────────────────────────────────────────────────

/// A future write path that forgets to normalise must FAIL LOUDLY. This is the
/// whole reason the CHECK exists: without it, "we always lowercase in Rust" is
/// a convention, and #251 reopens silently the first time someone adds a
/// seventh writer.
#[tokio::test]
async fn a_writer_that_forgets_to_lowercase_is_refused_by_the_database() {
    let (pool, db) = fresh_db().await;

    let err = sqlx::query("INSERT INTO users (username, email) VALUES ('raw', 'BOB@CORP.COM')")
        .execute(&pool)
        .await
        .expect_err("an un-normalised email must not be storable at all");

    let db_err = match &err {
        sqlx::Error::Database(e) => e,
        other => panic!("expected a database error, got {other:?}"),
    };
    // Postgres reports the CHECK violation code 23514; the SQLite leg refuses
    // via the invariant's guard triggers (`RAISE(ABORT)` → SQLITE_CONSTRAINT),
    // whose extended code is 1811. The load-bearing assertion on both is that
    // the failure names the invariant (never a silent lowercase-first write).
    #[cfg(not(feature = "sqlite-backend"))]
    assert_eq!(
        db_err.code().as_deref(),
        Some("23514"),
        "must be a CHECK violation (a loud, unmissable failure), got: {db_err}"
    );
    #[cfg(feature = "sqlite-backend")]
    assert!(
        db_err.to_string().contains("users_email_is_lowercase"),
        "must be the invariant guard's refusal (a loud, unmissable failure), got: {db_err}"
    );
    assert!(
        emails_in(&pool).await.is_empty(),
        "nothing may land when the invariant is violated"
    );

    drop_db(&db).await;
}

/// The plain `UNIQUE (email)` that already existed is sufficient ON NORMALISED
/// DATA — which is why no functional index is created. Proven, not assumed.
#[tokio::test]
async fn the_plain_unique_constraint_still_enforces_uniqueness_on_normalised_data() {
    let (pool, db) = fresh_db().await;

    // The sqlite leg must bind an explicit row id (no SQL-side UUID generator,
    // DEC-12) — the PG leg's `gen_random_uuid()` default does not exist there.
    #[cfg(not(feature = "sqlite-backend"))]
    pool.execute("INSERT INTO users (username, email) VALUES ('a', 'bob@corp.com')")
        .await
        .unwrap();
    #[cfg(feature = "sqlite-backend")]
    sqlx::query("INSERT INTO users (id, username, email) VALUES ($1, 'a', 'bob@corp.com')")
        .bind(Uuid::new_v4())
        .execute(&pool)
        .await
        .unwrap();

    #[cfg(not(feature = "sqlite-backend"))]
    let err = sqlx::query("INSERT INTO users (username, email) VALUES ('b', 'bob@corp.com')")
        .execute(&pool)
        .await
        .expect_err("duplicate normalised address");
    #[cfg(feature = "sqlite-backend")]
    let err = sqlx::query(
        "INSERT INTO users (id, username, email) VALUES ($1, 'b', 'bob@corp.com')",
    )
    .bind(Uuid::new_v4())
    .execute(&pool)
    .await
    .expect_err("duplicate normalised address");
    match &err {
        sqlx::Error::Database(e) => {
            #[cfg(not(feature = "sqlite-backend"))]
            assert_eq!(
                e.code().as_deref(),
                Some("23505"),
                "must be the unique violation, got: {e}"
            );
            #[cfg(feature = "sqlite-backend")]
            assert!(
                e.to_string().to_lowercase().contains("unique constraint failed"),
                "sqlite reports the UNIQUE (email) violation (users_email_key), got: {e}"
            );
        }
        other => panic!("expected a database error, got {other:?}"),
    }

    drop_db(&db).await;
}

/// #283 / #284 are DISSOLVED, not patched: the design reserves no index name,
/// so there is nothing to attribute a violation by and nothing to `DROP`.
///
/// This asserts the shape of the schema itself — if someone later "fixes" a
/// mapper by adding a functional unique index with a reserved name, this test
/// goes red and points at the two P1s that name buys back.
#[tokio::test]
async fn no_unique_index_on_users_is_a_functional_index_over_a_reserved_name() {
    let (pool, db) = fresh_db().await;

    // The introspection is driver-specific (pg_index vs sqlite_schema); the
    // ASSERTED PROPERTY is identical on both: the only unique indexes on
    // `users` are the four base-schema ones, NONE of which is an
    // expression/functional index, and the case-invariant enforcement is a
    // CHECK (Postgres) / guard triggers + the `lower(email)` unique index
    // (SQLite) — never a reserved-name functional UNIQUE index.
    #[cfg(not(feature = "sqlite-backend"))]
    let rows = sqlx::query(
        r#"
        SELECT i.relname AS name,
               pg_get_indexdef(ix.indexrelid) AS def,
               ix.indexprs IS NOT NULL AS is_expression
        FROM pg_index ix
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_class t ON t.oid = ix.indrelid
        WHERE t.relname = 'users' AND ix.indisunique
        ORDER BY i.relname
        "#,
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    #[cfg(feature = "sqlite-backend")]
    let rows = sqlx::query(
        r#"
        SELECT name,
               COALESCE(sql, '') AS def
        FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'users'
        ORDER BY name
        "#,
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    let names: Vec<String> = rows.iter().map(|r| r.get::<String, _>("name")).collect();
    #[cfg(not(feature = "sqlite-backend"))]
    assert_eq!(
        names,
        vec![
            // The base schema's single-root-admin partial index. Unrelated to
            // email, listed so the set below is exhaustive rather than filtered.
            "unique_root_admin".to_string(),
            "users_email_key".to_string(),
            "users_pkey".to_string(),
            "users_username_key".to_string(),
        ],
        "the ONLY unique indexes on users are the four the base schema always had; \
         a fifth means a reserved name was reintroduced and #283/#284 with it"
    );
    #[cfg(feature = "sqlite-backend")]
    assert_eq!(
        names,
        vec![
            // The sqlite port's complete index set on `users`: the six
            // base-schema accelerators (including `idx_users_lower_email` —
            // the PG chain's NON-unique `lower(email)` btree, ported as-is),
            // the three auto-indexes backing the UNIQUE constraints
            // (email / PK / username — the ported `users_email_key`,
            // `users_pkey`, `users_username_key`), the single-root-admin
            // partial index, and the ONE indexed case-invariant. Anything
            // else is a reserved name re-introduced and #283/#284 with it.
            "idx_users_created_at".to_string(),
            "idx_users_email".to_string(),
            "idx_users_is_active".to_string(),
            "idx_users_last_login_at".to_string(),
            "idx_users_lower_email".to_string(),
            "idx_users_username".to_string(),
            "sqlite_autoindex_users_1".to_string(),
            "sqlite_autoindex_users_2".to_string(),
            "sqlite_autoindex_users_3".to_string(),
            "unique_root_admin".to_string(),
            "users_email_lower_uniq".to_string(),
        ],
        "the sqlite chain's unique indexes are the three constraint auto-indexes + \
         the single-root-admin partial + the ONE recorded functional index; \
         anything else is a reserved name re-introduced"
    );
    #[cfg(not(feature = "sqlite-backend"))]
    for r in &rows {
        assert!(
            !r.get::<bool, _>("is_expression"),
            "no unique index on users may be a functional/expression index — that is \
             the reserved name #283 mis-attributes by and #284 drops: {}",
            r.get::<String, _>("def")
        );
        assert!(
            !r.get::<String, _>("def").to_lowercase().contains("lower("),
            "no unique index on users may fold case — uniqueness comes from the plain \
             UNIQUE (email) over normalised data: {}",
            r.get::<String, _>("def")
        );
    }
    #[cfg(feature = "sqlite-backend")]
    for r in &rows {
        let name = r.get::<String, _>("name");
        let def = r.get::<String, _>("def");
        // The sqlite port (migrations-sqlite/202609090010) enforces the
        // case-invariant with ONE functional unique index — `lower(email)`,
        // named `users_email_lower_uniq` and DOCUMENTED as the accepted port
        // difference (SQLite cannot attach a table CHECK). It is the ONLY
        // such index; anything else is the reserved-name regression.
        if name == "users_email_lower_uniq" {
            assert!(
                def.to_lowercase().contains("lower("),
                "the single sanctioned functional index must fold case: {def}"
            );
        } else if name == "idx_users_lower_email" {
            // The PG chain's NON-unique `lower(email)` btree, ported as-is:
            // an accelerator only — it makes nothing unique, so it cannot
            // re-open #251 (that is the `users_email_lower_uniq` job).
            assert!(
                def.to_lowercase().contains("lower("),
                "the ported accelerator must still fold case: {def}"
            );
        } else {
            assert!(
                !def.to_lowercase().contains("lower("),
                "no OTHER index on users may fold case — the invariant lives in the \
                 recorded `users_email_lower_uniq` + the guard triggers: {def}"
            );
        }
    }

    // And the invariant that makes the plain UNIQUE sufficient is present, on
    // the users table, as a CHECK — a name that cannot collide with another
    // table's object the way an index name can.
    #[cfg(not(feature = "sqlite-backend"))]
    {
        let check: Option<String> = sqlx::query_scalar(
            "SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c \
             JOIN pg_class t ON t.oid = c.conrelid \
             WHERE t.relname = 'users' AND c.conname = 'users_email_is_lowercase'",
        )
        .fetch_optional(&pool)
        .await
        .unwrap();
        assert_eq!(
            check.as_deref(),
            Some("CHECK (((email)::text = lower((email)::text)))"),
            "the case-insensitive uniqueness must come from this CHECK, not an index"
        );
    }
    #[cfg(feature = "sqlite-backend")]
    {
        // The sqlite chain enforces the case-invariant with the guard
        // triggers + the `lower(email)` unique index (see
        // migrations-sqlite/202609090010); the property asserted is the same
        // "comes from the invariant object, not a reserved-name index".
        let guards: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' \
                                AND name LIKE 'users_email_is_lowercase%'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(guards, 2, "the two guard triggers must exist");
    }

    drop_db(&db).await;
}

// ───────────────────────────────────────────────────────────────────────────
// 3. Every write path — enumerated from `INSERT INTO users` / `UPDATE users`
//    across the whole SDK, not hand-picked.
// ───────────────────────────────────────────────────────────────────────────

/// Every path that writes `users.email` normalises. One test per writer, so a
/// new writer that skips normalisation is a hole this file does not cover —
/// and the CHECK turns that hole into a hard failure rather than a silent
/// second principal.
#[tokio::test]
async fn every_write_path_normalises_the_stored_address() {
    let (pool, db) = fresh_db().await;
    let auth = AuthRepository::new(pool.clone());
    let users = UserRepository::new(pool.clone());

    // 1. AuthRepository::create_local_user_with_default_group (POST /auth/register)
    let u = auth
        .create_local_user_with_default_group("w1", " W1@Corp.COM ", None, None)
        .await
        .unwrap();
    assert_eq!(u.email, "w1@corp.com");

    // 2. AuthRepository::provision_external_user_atomic (OAuth first login)
    let id2 = auth
        .provision_external_user_atomic(
            "w2",
            Some(" W2@Corp.COM "),
            true,
            "W2",
            provider_id(),
            "ext-2",
            None,
        )
        .await
        .unwrap();

    // 3. AuthRepository::create_external_user
    let id3 = auth
        .create_external_user("w3", Some(" W3@Corp.COM ".to_string()), "W3")
        .await
        .unwrap();

    // 4. AuthRepository::create_external_user_with_link (LDAP first login)
    let id4 = auth
        .create_external_user_with_link(
            "w4",
            Some(" W4@Corp.COM ".to_string()),
            "W4",
            provider_id(),
            "ext-4",
        )
        .await
        .unwrap();

    // 5. UserRepository::create (admin create / first-run setup)
    let u5 = users
        .create("w5", " W5@Corp.COM ", None, None, None)
        .await
        .unwrap();
    assert_eq!(u5.email, "w5@corp.com");

    // 6. UserRepository::update (admin edit)
    let u6 = users
        .update(u5.id, None, Some(" W6@Corp.COM ".to_string()), None, None)
        .await
        .unwrap();
    assert_eq!(u6.email, "w6@corp.com");

    // …and `None` on that path still means "leave the address alone". A
    // normaliser applied to the absent case would fold `None` into `Some("")`
    // and the COALESCE would blank the column on every unrelated edit.
    let u6b = users
        .update(u6.id, Some("w6-renamed".to_string()), None, None, None)
        .await
        .unwrap();
    assert_eq!(u6b.email, "w6@corp.com", "an edit that omits the email must not touch it");
    assert_eq!(u6b.username, "w6-renamed");

    let stored = |id: Uuid| {
        let pool = pool.clone();
        async move {
            sqlx::query("SELECT email FROM users WHERE id = $1")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap()
                .get::<String, _>("email")
        }
    };
    assert_eq!(stored(u.id).await, "w1@corp.com");
    assert_eq!(stored(id2).await, "w2@corp.com");
    assert_eq!(stored(id3).await, "w3@corp.com");
    assert_eq!(stored(id4).await, "w4@corp.com");
    assert_eq!(stored(u6.id).await, "w6@corp.com");

    drop_db(&db).await;
}

/// The ASCII restriction is LOAD-BEARING (#260): outside printable ASCII the
/// Rust fold and the Postgres fold disagree, so a Rust-lowered value could fail
/// the CHECK and surface as a 500 on a shipped path. Every write path refuses
/// such an address at the boundary rather than sanitising it or letting it
/// reach Postgres.
///
/// `İ` (U+0130) is the exact divergence: Postgres folds it to one character,
/// Rust to two.
#[tokio::test]
async fn every_write_path_refuses_a_non_ascii_address() {
    let (pool, db) = fresh_db().await;
    let auth = AuthRepository::new(pool.clone());
    let users = UserRepository::new(pool.clone());

    const NON_ASCII: &str = "İgor@corp.com";

    let e1 = auth
        .create_local_user_with_default_group("n1", NON_ASCII, None, None)
        .await
        .expect_err("create_local_user_with_default_group must refuse");
    assert_eq!(e1.status_code(), 400, "{e1}");
    assert_eq!(e1.error_code(), "INVALID_EMAIL");

    let e2 = auth
        .provision_external_user_atomic(
            "n2",
            Some(NON_ASCII),
            true,
            "N2",
            provider_id(),
            "ext-n2",
            None,
        )
        .await
        .expect_err("provision_external_user_atomic must refuse");
    assert_eq!(e2.status_code(), 400, "{e2}");

    let e3 = auth
        .create_external_user("n3", Some(NON_ASCII.to_string()), "N3")
        .await
        .expect_err("create_external_user must refuse");
    assert_eq!(e3.status_code(), 400, "{e3}");

    let e4 = auth
        .create_external_user_with_link(
            "n4",
            Some(NON_ASCII.to_string()),
            "N4",
            provider_id(),
            "ext-n4",
        )
        .await
        .expect_err("create_external_user_with_link must refuse");
    assert_eq!(e4.status_code(), 400, "{e4}");

    let e5 = users
        .create("n5", NON_ASCII, None, None, None)
        .await
        .expect_err("UserRepository::create must refuse");
    assert_eq!(e5.status_code(), 400, "{e5}");

    let held = users.create("n6", "n6@corp.com", None, None, None).await.unwrap();
    let e6 = users
        .update(held.id, None, Some(NON_ASCII.to_string()), None, None)
        .await
        .expect_err("UserRepository::update must refuse");
    assert_eq!(e6.status_code(), 400, "{e6}");

    // Nothing landed, and the one legitimate row is untouched.
    assert_eq!(emails_in(&pool).await, vec!["n6@corp.com".to_string()]);

    // And the route says 400, not 500 — a non-ASCII address is a bad request,
    // not a database error leaking through the CHECK.
    let (status, code) = post_register(&pool, "nseven", NON_ASCII).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(code.as_deref(), Some("INVALID_EMAIL"));

    drop_db(&db).await;
}

/// The claim the ASCII gate rests on, stated and checked rather than assumed:
/// over every address the gate admits, the Rust fold and the DATABASE's fold
/// produce the same bytes (Postgres `lower` / SQLite's ASCII-only `lower` —
/// the same ASCII limitation, DEC-11). If this ever goes red, the invariant
/// (CHECK on Postgres, guard triggers on SQLite) starts rejecting values the
/// writers produce.
#[tokio::test]
async fn rust_and_database_folds_agree_over_every_admissible_character() {
    let (pool, db) = fresh_db().await;

    // Every printable-ASCII code point the gate admits, as a one-character
    // probe, plus the assembled address shape.
    let probes: Vec<String> = (0x21u8..=0x7eu8).map(|b| (b as char).to_string()).collect();
    for probe in &probes {
        let rust = probe.to_lowercase();
        let db_fold: String = sqlx::query_scalar("SELECT lower($1)")
            .bind(probe)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            rust, db_fold,
            "Rust and the database must fold {probe:?} identically — the ASCII gate is \
             what makes the case-invariant satisfiable by a Rust-lowered value"
        );
    }

    drop_db(&db).await;
}

// ───────────────────────────────────────────────────────────────────────────
// 4. The migration: what it does to existing rows, and what it REFUSES to do.
// ───────────────────────────────────────────────────────────────────────────

/// The migration's own text, so these tests exercise the shipped SQL rather
/// than a paraphrase of it (each driver's own file — the sqlite chain is the
/// DEC-8/DEC-9 port of the same version-numbered migration).
#[cfg(not(feature = "sqlite-backend"))]
const MIGRATION: &str =
    include_str!("../migrations/202609090010_users_email_lowercase_invariant.sql");
#[cfg(feature = "sqlite-backend")]
const MIGRATION: &str =
    include_str!("../migrations-sqlite/202609090010_users_email_lowercase_invariant.sql");

/// Put the database back into its pre-migration shape so the migration can be
/// re-run against data planted afterwards. Postgres: dropping the CHECK is the
/// whole of it. SQLite: dropping the invariant's unique index + the two guard
/// triggers (the port's CHECK-equivalents — see migrations-sqlite).
#[cfg(not(feature = "sqlite-backend"))]
async fn undo_the_invariant(pool: &DbPool) {
    pool.execute("ALTER TABLE public.users DROP CONSTRAINT users_email_is_lowercase")
        .await
        .expect("the migration under test must have added this constraint");
}

#[cfg(feature = "sqlite-backend")]
async fn undo_the_invariant(pool: &DbPool) {
    pool.execute("DROP TRIGGER users_email_is_lowercase_insert_guard")
        .await
        .expect("the migration under test must have added this trigger");
    pool.execute("DROP TRIGGER users_email_is_lowercase_update_guard")
        .await
        .expect("the migration under test must have added this trigger");
    pool.execute("DROP INDEX users_email_lower_uniq")
        .await
        .expect("the migration under test must have added this index");
}

#[cfg(not(feature = "sqlite-backend"))]
async fn run_migration(pool: &DbPool) -> Result<(), sqlx::Error> {
    sqlx::raw_sql(MIGRATION).execute(pool).await.map(|_| ())
}

#[cfg(feature = "sqlite-backend")]
async fn run_migration(pool: &DbPool) -> Result<(), sqlx::Error> {
    sqlx::raw_sql(MIGRATION).execute(pool).await.map(|_| ())
}

/// HAZARD (a): two existing rows that differ ONLY by case are two accounts.
/// The migration must NOT pick one — merging or deleting either is a data-loss
/// decision, and choosing the wrong survivor is the privilege escalation #251
/// is about. It aborts, naming the colliding addresses so a human can decide.
#[tokio::test]
async fn the_migration_refuses_to_adjudicate_two_rows_that_differ_only_by_case() {
    let (pool, db) = fresh_db().await;
    undo_the_invariant(&pool).await;

    #[cfg(not(feature = "sqlite-backend"))]
    pool.execute(
        "INSERT INTO users (username, email) VALUES \
         ('bob', 'bob@corp.com'), ('mallory', 'BOB@CORP.COM'), ('zoe', 'Zoe@Corp.com')",
    )
    .await
    .unwrap();
    #[cfg(feature = "sqlite-backend")]
    sqlx::query(
        "INSERT INTO users (id, username, email) VALUES \
         ($1, 'bob', 'bob@corp.com'), ($2, 'mallory', 'BOB@CORP.COM'), ($3, 'zoe', 'Zoe@Corp.com')",
    )
    .bind(Uuid::new_v4())
    .bind(Uuid::new_v4())
    .bind(Uuid::new_v4())
    .execute(&pool)
    .await
    .unwrap();

    let err = run_migration(&pool)
        .await
        .expect_err("the migration must refuse to lowercase a colliding pair");
    let msg = err.to_string();

    // The postgres leg aborts in a DO block naming the colliding addresses;
    // the sqlite leg's refuse is the `lower(email)` unique-index creation
    // failing (a rollback of the whole migration, data untouched) — the
    // message names the index constraint, not the addresses. Both are a hard
    // refuse; the DATA assertions below are the load-bearing half on sqlite.
    #[cfg(not(feature = "sqlite-backend"))]
    for expected in ["bob@corp.com", "BOB@CORP.COM", "#251"] {
        assert!(
            msg.contains(expected),
            "the abort must name {expected:?} so an operator can act on it; got:\n{msg}"
        );
    }
    #[cfg(feature = "sqlite-backend")]
    assert!(
        msg.to_lowercase().contains("unique") || msg.to_lowercase().contains("constraint"),
        "the sqlite migration must fail loudly on the case-collision; got:\n{msg}"
    );

    // Nothing was merged, deleted, or half-lowercased: all three rows are
    // exactly as they were, and the invariant was NOT installed.
    assert_eq!(
        emails_in(&pool).await,
        vec![
            "BOB@CORP.COM".to_string(),
            "Zoe@Corp.com".to_string(),
            "bob@corp.com".to_string(),
        ],
        "a refused migration must leave every row untouched — including the \
         non-colliding one it would otherwise have rewritten"
    );
    #[cfg(not(feature = "sqlite-backend"))]
    {
        let constrained: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_email_is_lowercase')",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(!constrained, "a refused migration must not install the invariant");
    }
    #[cfg(feature = "sqlite-backend")]
    {
        let guards: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' \
                                AND name LIKE 'users_email_is_lowercase%'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(guards, 0, "a refused migration must not install the invariant");
    }

    drop_db(&db).await;
}

/// The other half: with no collision to adjudicate, existing rows ARE
/// lowercased and the invariant goes on.
#[tokio::test]
async fn the_migration_lowercases_existing_rows_when_there_is_no_collision() {
    let (pool, db) = fresh_db().await;
    undo_the_invariant(&pool).await;

    #[cfg(not(feature = "sqlite-backend"))]
    pool.execute(
        "INSERT INTO users (username, email) VALUES \
         ('erin', 'Erin@Corp.com'), ('frank', 'FRANK@CORP.COM'), ('gina', 'gina@corp.com')",
    )
    .await
    .unwrap();
    #[cfg(feature = "sqlite-backend")]
    sqlx::query(
        "INSERT INTO users (id, username, email) VALUES \
         ($1, 'erin', 'Erin@Corp.com'), ($2, 'frank', 'FRANK@CORP.COM'), ($3, 'gina', 'gina@corp.com')",
    )
    .bind(Uuid::new_v4())
    .bind(Uuid::new_v4())
    .bind(Uuid::new_v4())
    .execute(&pool)
    .await
    .unwrap();

    run_migration(&pool).await.expect("no collision → the migration applies");

    assert_eq!(
        emails_in(&pool).await,
        vec![
            "erin@corp.com".to_string(),
            "frank@corp.com".to_string(),
            "gina@corp.com".to_string(),
        ]
    );

    // …and the invariant now holds for anything written afterwards.
    sqlx::query("INSERT INTO users (username, email) VALUES ('h', 'H@Corp.com')")
        .execute(&pool)
        .await
        .expect_err("the invariant must be enforced after the migration re-runs");

    drop_db(&db).await;
}

/// #284 in migration form: the migration must not be able to damage an object
/// belonging to another table. It drops nothing and reserves no index name, so
/// this is a shape assertion — a foreign table carrying an index named after
/// ours survives untouched, because there is no "ours" to collide with.
#[tokio::test]
async fn the_migration_touches_nothing_outside_the_users_table() {
    let (pool, db) = fresh_db().await;
    undo_the_invariant(&pool).await;

    // The shape assertion is the same on both engines: an unrelated table
    // carrying indexes named after ours survives untouched.
    #[cfg(not(feature = "sqlite-backend"))]
    {
        pool.execute(
            "CREATE TABLE public.mailboxes (addr text); \
             CREATE UNIQUE INDEX users_email_is_lowercase ON public.mailboxes (lower(addr)); \
             CREATE UNIQUE INDEX users_email_lower_unique_idx ON public.mailboxes (lower(addr))",
        )
        .await
        .unwrap();

        run_migration(&pool).await.expect("the migration applies");

        let survivors: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM pg_indexes WHERE tablename = 'mailboxes' \
             AND indexname IN ('users_email_is_lowercase', 'users_email_lower_unique_idx')",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            survivors, 2,
            "an unrelated table's indexes must survive; the earlier shape's \
             schema-qualified-but-not-table-qualified DROP INDEX destroyed them (#284)"
        );

        // The foreign table still refuses a case-variant duplicate, i.e. it still
        // has the uniqueness it had before.
        pool.execute("INSERT INTO public.mailboxes VALUES ('bob@corp.com')")
            .await
            .unwrap();
        sqlx::query("INSERT INTO public.mailboxes VALUES ('BOB@CORP.COM')")
            .execute(&pool)
            .await
            .expect_err("mailboxes must still be unique on lower(addr)");
    }
    #[cfg(feature = "sqlite-backend")]
    {
        pool.execute(
            "CREATE TABLE mailboxes (addr TEXT); \
             CREATE UNIQUE INDEX users_email_is_lowercase ON mailboxes (lower(addr)); \
             CREATE UNIQUE INDEX users_email_lower_unique_idx ON mailboxes (lower(addr))",
        )
        .await
        .unwrap();

        run_migration(&pool).await.expect("the migration applies");

        let survivors: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM sqlite_master WHERE type = 'index' \
             AND tbl_name = 'mailboxes' \
             AND name IN ('users_email_is_lowercase', 'users_email_lower_unique_idx')",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            survivors, 2,
            "an unrelated table's indexes must survive (the sqlite chain drops \
             nothing by index name either)"
        );

        pool.execute("INSERT INTO mailboxes VALUES ('bob@corp.com')")
            .await
            .unwrap();
        sqlx::query("INSERT INTO mailboxes VALUES ('BOB@CORP.COM')")
            .execute(&pool)
            .await
            .expect_err("mailboxes must still be unique on lower(addr)");
    }

    drop_db(&db).await;
}

// ───────────────────────────────────────────────────────────────────────────
// 5. The two local login resolvers must name the SAME principal.
// ───────────────────────────────────────────────────────────────────────────

/// `ziee-auth` has two resolvers that turn a typed identifier into a
/// principal: `UserRepository::get_by_username_or_email` (the `login` handler)
/// and `LocalAuthProvider` (the provider path — username first, then
/// `get_by_email`). Normalising stored addresses changes what BOTH of them
/// match, and a fix that folded only one would leave two answers to "who is
/// `BOB@CORP.COM`?" on two authentication paths.
///
/// The provider half is driven through its PUBLIC `authenticate`, whose
/// `external_id` is the resolved user's id — so this asserts the
/// authentication decision, not a lookup. All three users share one password,
/// precisely so that the password cannot mask which principal was chosen.
///
/// Three users are seeded and the assertion compares user IDs: with one user,
/// or a boolean assertion, neither the ordering nor the who-wins is
/// observable. `mallory` deliberately holds, as a USERNAME, the case variant
/// of `bob`'s address — that is the ambiguous identifier.
#[tokio::test]
async fn both_local_login_resolvers_name_the_same_principal_for_every_identifier() {
    let (pool, db) = fresh_db().await;
    let users = UserRepository::new(pool.clone());

    let hash = Some(hash_password(PASSWORD).unwrap());
    let bob = users
        .create("bob", "Bob@Corp.com", hash.clone(), None, None)
        .await
        .unwrap();
    let mallory = users
        .create("BOB@CORP.COM", "mallory@corp.com", hash.clone(), None, None)
        .await
        .unwrap();
    let carol = users
        .create("carol", "carol@corp.com", hash.clone(), None, None)
        .await
        .unwrap();

    let provider = LocalAuthProvider::new(&local_provider_row(), pool.clone()).unwrap();

    for identifier in [
        "bob",
        "carol",
        "bob@corp.com",   // bob's stored (normalised) address
        "Bob@Corp.com",   // …as he typed it at registration
        "BOB@CORP.COM",   // the ambiguous one: mallory's USERNAME, bob's email
        "CAROL@corp.com",
        "mallory@corp.com",
        "nobody@corp.com",
    ] {
        let via_handler = users
            .get_by_username_or_email(identifier)
            .await
            .unwrap()
            .map(|u| u.id.to_string());
        let via_provider = provider
            .authenticate(identifier, PASSWORD)
            .await
            .ok()
            .map(|r| r.external_id);
        assert_eq!(
            via_handler, via_provider,
            "the two local login resolvers disagree about who {identifier:?} names"
        );
    }

    // …and the answers are the RIGHT ones, not merely equal.
    let who = |id: &'static str| {
        let users = UserRepository::new(pool.clone());
        async move { users.get_by_username_or_email(id).await.unwrap().map(|u| u.id) }
    };
    assert_eq!(
        who("Bob@Corp.com").await,
        Some(bob.id),
        "a user must still be able to log in with the address AS THEY TYPED IT at \
         registration — the migration lowercased what is stored, so an exact-match \
         resolver would lock every mixed-case registrant out of email login"
    );
    assert_eq!(who("bob@corp.com").await, Some(bob.id));
    assert_eq!(
        who("BOB@CORP.COM").await,
        Some(mallory.id),
        "an identifier that is one row's USERNAME and another row's email resolves to \
         the username holder — deterministically, and identically on both resolvers"
    );
    assert_eq!(who("CAROL@corp.com").await, Some(carol.id));
    assert_eq!(who("nobody@corp.com").await, None);

    drop_db(&db).await;
}
