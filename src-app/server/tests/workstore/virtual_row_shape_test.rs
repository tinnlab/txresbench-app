//! **TEST-31 [covers: ITEM-16]** — a row is STORED xor GATHERED, enforced by the database.
//!
//! > A virtual artifact's defining fact is not a boolean. It is the presence of a
//! > RESOLUTION RECIPE, which the serve path has to read anyway. A flag beside that recipe
//! > would be two sources for one value, and the two could DISAGREE.
//! > — DEC-8 (corrected at phase 5), realizing `202608040002`'s
//! >   *"two sources for one value is the ambiguity INV-2 forbids"*.
//!
//! ## What this asserts, and what it deliberately does NOT
//!
//! This test previously read *"every Rust match over the storage kind is exhaustive"*. That
//! assertion is now meaningless — DEC-8 was corrected to add **no discriminant column**, so
//! there is no kind to match. It was retargeted rather than deleted, onto the property that
//! actually carries the invariant: the `artifacts_bytes_or_recipe` CHECK constraint.
//!
//! That is a stronger test than the one it replaced. An exhaustive-match assertion is a
//! statement about Rust source that a future writer bypasses by adding a wildcard arm; a
//! CHECK constraint is enforced by Postgres against **every** writer, including one that has
//! never read the migration — and including raw SQL, a migration, or a future service.
//!
//! ## Why the two REFUSAL cases are the load-bearing ones
//!
//! The two *coherent* inserts passing proves only that the table still accepts rows. Both
//! would pass identically **with the constraint dropped**. So the assertions that make this
//! test mean anything are the two incoherent rows being REFUSED:
//!
//!   * **both** an `object_key` and a recipe → which one produces the bytes? A reader that
//!     picks the key serves stale/foreign bytes; one that picks the recipe ignores a real
//!     blob. Neither is detectable at read time.
//!   * **neither** → unreadable by every path, and nothing on the row says why. This is the
//!     shape a partial write or a future writer that forgot the recipe would produce.
//!
//! The negative control for the whole file is therefore: **drop the constraint and both
//! refusal assertions go red while both positive ones stay green.**

use serde_json::json;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::common::TestServer;

use super::{create_project, pool_for, setup_admin};

/// Insert an artifact row directly, bypassing every Rust-side guard.
///
/// Deliberately raw SQL rather than `CatalogRepository`: the point is that the DATABASE
/// refuses these rows, so routing through a Rust writer that might reject them first would
/// test the writer instead of the constraint — and it is the writer this constraint exists
/// to outlive.
async fn try_insert(
    pool: &SqlitePool,
    project_id: Uuid,
    output_id: &str,
    object_key: Option<&str>,
    structure: serde_json::Value,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"INSERT INTO artifacts
             (id, project_id, run_id, output_id, datatype, object_key, is_multifile,
              content_hash, structure, meta, role, status, stored_bytes)
           VALUES ($1, $2, NULL, $3, 'data/opaque', $4, false,
                   'sha256:deadbeef', $5, '{}', 'artifact', 'ready', 0)"#,
    )
    .bind(Uuid::new_v4())
    .bind(project_id)
    .bind(output_id)
    .bind(object_key)
    .bind(structure)
    .execute(pool)
    .await
    .map(|_| ())
}

/// The recipe a gathered artifact carries. Its CONTENTS are ITEM-17/19's business; all this
/// test needs is that the key is present, which is what the constraint keys on.
fn recipe() -> serde_json::Value {
    json!({
        "kind": "table",
        "axis": "entries",
        "n": 3,
        "gathered_from": {
            "alignment_id": "00000000-0000-0000-0000-0000000000aa",
            "column": "celltype"
        }
    })
}

fn plain_structure() -> serde_json::Value {
    json!({ "kind": "table", "axis": "entries", "n": 3 })
}

#[tokio::test]
async fn test31_a_row_is_stored_xor_gathered() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "virtual row shape").await;
    let pool = pool_for(&server).await;

    // ── POSITIVE CONTROL 1 — a STORED artifact still inserts ─────────────────────────
    // Without this the refusals below would pass just as well against a table that
    // rejects everything (a typo'd column, a NOT NULL left in place, a bad datatype).
    try_insert(
        &pool,
        project,
        "stored-one",
        Some("sha256:aaaa"),
        plain_structure(),
    )
    .await
    .expect(
        "a STORED artifact (object_key, no recipe) must insert — if this fails the refusal \
         assertions below are vacuous and prove nothing about the constraint",
    );

    // ── POSITIVE CONTROL 2 — a GATHERED artifact inserts ─────────────────────────────
    // This is the whole point of ITEM-16: before this migration, `object_key NOT NULL`
    // made this row unrepresentable. If it fails, the capability does not exist.
    try_insert(&pool, project, "gathered-one", None, recipe())
        .await
        .expect(
            "a GATHERED artifact (NULL object_key + structure.gathered_from) must insert — \
             this is the row ITEM-16 exists to make representable",
        );

    // ── REFUSAL 1 — BOTH bytes and a recipe ──────────────────────────────────────────
    // Two sources for one value, and unlike `storage_layout` they can disagree: which one
    // produces the bytes? A reader picking the key serves a blob the recipe contradicts;
    // one picking the recipe ignores a real blob. Neither is visible at read time.
    let both = try_insert(
        &pool,
        project,
        "both-key-and-recipe",
        Some("sha256:bbbb"),
        recipe(),
    )
    .await;
    let err = both.expect_err(
        "a row with BOTH an object_key and structure.gathered_from must be REFUSED — two \
         sources for one value is exactly the ambiguity DEC-8 rejected the flag design over",
    );
    assert!(
        err.to_string().contains("artifacts_bytes_or_recipe"),
        "the refusal must come from the CHECK constraint by name, not from some incidental \
         failure (a NOT NULL, a type error, a unique index) — otherwise this assertion \
         passes for the wrong reason. Got: {err}"
    );

    // ── REFUSAL 2 — NEITHER bytes nor a recipe ───────────────────────────────────────
    // Unreadable by every path, with nothing on the row explaining why. This is the shape
    // a partial write, or a future writer that forgot the recipe, would produce — and it
    // is the one a `storage_kind` flag would have happily accepted.
    let neither = try_insert(&pool, project, "neither", None, plain_structure()).await;
    let err = neither.expect_err(
        "a row with NEITHER an object_key nor structure.gathered_from must be REFUSED — it \
         is unreadable by every path and nothing on it says so",
    );
    assert!(
        err.to_string().contains("artifacts_bytes_or_recipe"),
        "the refusal must come from the CHECK constraint by name. Got: {err}"
    );
}

/// The constraint must key on the RECIPE, not merely on `structure` being non-empty.
///
/// Without this, `CHECK (object_key IS NOT NULL OR structure <> '{{}}')` would pass the test
/// above — every artifact has a non-empty `structure` — while accepting a NULL key on any
/// ordinary artifact and rejecting nothing that matters.
#[tokio::test]
async fn test31_the_constraint_keys_on_the_recipe_not_on_structure_being_present() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "virtual row shape keying").await;
    let pool = pool_for(&server).await;

    // A rich structure with NO `gathered_from` key. A constraint that merely checked
    // "structure is non-empty" would accept this with a NULL object_key; the real one
    // must refuse it.
    let rich_but_not_gathered = json!({
        "kind": "table",
        "axis": "entries",
        "n": 3,
        "columns": [{ "path": "values", "kind": "numeric" }],
        "meta_ish": { "nested": { "deep": true } }
    });

    let refused = try_insert(
        &pool,
        project,
        "rich-no-recipe",
        None,
        rich_but_not_gathered,
    )
    .await
    .expect_err(
        "a NULL object_key with a rich structure that has no `gathered_from` key must \
             still be REFUSED — the constraint keys on the RECIPE, not on structure being \
             non-empty",
    );
    assert!(
        refused.to_string().contains("artifacts_bytes_or_recipe"),
        "expected the CHECK constraint by name. Got: {refused}"
    );
}
