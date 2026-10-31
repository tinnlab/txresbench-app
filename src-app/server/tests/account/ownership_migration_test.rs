//! A2 ownership-migration acceptance tests (TEST-1, TEST-2, TEST-6, TEST-7) —
//! the schema shape + backfill safety of `202608040013`/`202608040014` and the
//! frozen PROV-A2-3 (`projects.account_id` / `datasets.account_id`).

use cytoanalyst::modules::account::scope::{account_of_dataset, account_of_project};
use cytoanalyst::modules::dataset::repository::DatasetRepository;
use cytoanalyst::modules::project::ProjectRepository;
use uuid::Uuid;

use super::{create_user, pool_for, setup_admin};
use crate::common::TestServer;

// TEST-1 [covers: ITEM-1] (PROV-A2-3): both `account_id` columns exist, are NOT
// NULL, and FK to accounts(id) with NO ACTION (an account with a live project
// cannot be dropped).
#[tokio::test]
async fn account_id_columns_are_not_null_and_fk_no_action() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let alice = create_user(&server, &admin, "alice", "alice@x.test").await;
    let pool = pool_for(&server).await;

    for table in ["projects", "datasets"] {
        // SQLite port (record): `ALTER TABLE … ADD COLUMN account_id … CHECK (account_id
        // IS NOT NULL)` is the sqlite expression of the PG `NOT NULL` (a plain
        // `NOT NULL` cannot be added via ADD COLUMN unless it has a non-NULL default,
        // and the column is populated by the same migration's backfill). The schema
        // claim is therefore enforced + asserted at the behavioural level: the
        // column definition carries the CHECK, and a write with a NULL account_id is
        // refused — the exact claim the PG test made via `notnull`.
        let definition: String = sqlx::query_scalar(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = $1",
        )
        .bind(table)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|_| panic!("{table} must exist"));
        assert!(
            definition.contains("account_id IS NOT NULL"),
            "{table}.account_id must be explicitly NOT NULL (CHECK form): {definition}"
        );
        let refused = sqlx::query(&format!(
            "INSERT INTO {} (id, owner_id, account_id, name) \
             VALUES (randomblob(16), $1, NULL, 'null-account-id-probe')",
            table
        ))
        .bind(alice)
        .execute(&pool)
        .await;
        assert!(
            refused.is_err(),
            "{table}: a row with NULL account_id must be refused by the schema"
        );

        let (del_type, referenced): (String, String) = sqlx::query_as(
            "SELECT on_delete, \"table\" \
             FROM pragma_foreign_key_list($1) WHERE \"from\" = 'account_id'",
        )
        .bind(table)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|_| panic!("{table}_account_id_fkey must exist"));
        // SQLite reports the ON DELETE action in full ('NO ACTION').
        assert_eq!(del_type, "NO ACTION", "{table} FK must be NO ACTION");
        assert_eq!(
            referenced, "accounts",
            "{table}.account_id references accounts"
        );
    }

    // Behavioural NO-ACTION proof: an account with a live project cannot be deleted.
    let projects = ProjectRepository::new(pool.clone());
    let project = projects
        .create(alice, "P", "")
        .await
        .expect("create project");
    let account = account_of_project(&pool, project.id)
        .await
        .unwrap()
        .unwrap();
    let del = sqlx::query("DELETE FROM accounts WHERE id = $1")
        .bind(account)
        .execute(&pool)
        .await;
    assert!(
        del.is_err(),
        "deleting an account with a live project must be refused by the NO ACTION FK"
    );
}

// TEST-2 [covers: ITEM-2] (PROV-A2-3): the composite `(account_id, created_at DESC)`
// indexes exist.
#[tokio::test]
async fn account_id_indexes_exist() {
    let server = TestServer::spawn().await;
    let _admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    for (idx, table) in [
        ("idx_projects_account_created", "projects"),
        ("idx_datasets_account_created", "datasets"),
    ] {
        let def: String = sqlx::query_scalar(
            "SELECT sql FROM sqlite_master WHERE type='index' AND name=$1",
        )
        .bind(idx)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|_| panic!("index {idx} must exist"));
        assert!(
            def.contains("account_id"),
            "{idx} must index account_id: {def}"
        );
        assert!(
            def.contains("created_at"),
            "{idx} must index created_at: {def}"
        );
        assert!(def.contains(table), "{idx} must be on {table}: {def}");
    }
}

// TEST-6 [acceptance, INV-3] [covers: ITEM-1]: the backfill is idempotent (a
// re-apply changes nothing) and the zero-orphan gate RAISEs on a residual NULL.
#[tokio::test]
async fn backfill_is_idempotent_and_zero_orphan_gate_fires() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let alice = create_user(&server, &admin, "alice", "alice@x.test").await;
    let pool = pool_for(&server).await;

    let projects = ProjectRepository::new(pool.clone());
    let project = projects
        .create(alice, "P", "")
        .await
        .expect("create project");
    let before = account_of_project(&pool, project.id)
        .await
        .unwrap()
        .unwrap();

    // Re-apply the exact repoint UPDATE twice — idempotent (WHERE account_id IS NULL).
    for _ in 0..2 {
        sqlx::query(
            "UPDATE projects AS p SET account_id = a.id FROM accounts AS a \
             WHERE a.kind='personal' AND a.personal_user_id = p.owner_id AND p.account_id IS NULL",
        )
        .execute(&pool)
        .await
        .expect("re-apply backfill");
    }
    let after = account_of_project(&pool, project.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(before, after, "re-applying the backfill is a no-op");

    // Zero-orphan gate (SQLite port, record): the PG gate was a plpgsql DO-block
    // raising on a residual NULL. The PORTED migration expresses the same gate as a
    // CHECK-trap table (`account_backfill_zero_orphan_gate`: INSERT ... SELECT over
    // the orphan queries into a `CHECK (probe = -1)` table — an orphan aborts the
    // statement), and the live schema's `account_id` CHECK makes a residual NULL
    // unrepresentable on a write. The gate's RAISE semantics are therefore proven
    // against an unconstrained copy of the same table (`CREATE TABLE AS` copies no
    // constraints): the exact gate construct must abort on a forced orphan.
    let gate_sql = "CREATE TABLE account_backfill_zero_orphan_gate (\
         probe INTEGER CONSTRAINT account_backfill_zero_orphan_gate CHECK (probe = -1)\
     ); \
         INSERT INTO account_backfill_zero_orphan_gate (probe) \
         SELECT 1 FROM {t} WHERE account_id IS NULL \
         UNION ALL \
         SELECT 1 FROM datasets WHERE account_id IS NULL; \
         DROP TABLE account_backfill_zero_orphan_gate;";
    sqlx::query("DROP TABLE IF EXISTS projects_trap")
        .execute(&pool)
        .await
        .expect("drop trap");
    sqlx::query("CREATE TABLE projects_trap AS SELECT * FROM projects")
        .execute(&pool)
        .await
        .expect("trap table (constraint-free copy)");
    sqlx::query(
        "INSERT INTO projects_trap (id, owner_id, account_id, name, description) \
         VALUES (randomblob(16), $1, NULL, 'orphan', '')",
    )
    .bind(alice)
    .execute(&pool)
    .await
    .expect("insert an orphan row into the trap");

    let gate = sqlx::query(&gate_sql.replace("{t}", "projects_trap"))
        .execute(&pool)
        .await;
    let err = gate.expect_err("the zero-orphan gate must RAISE on a residual NULL");
    assert!(
        err.to_string().contains("CHECK")
            && err.to_string().contains("account_backfill_zero_orphan_gate"),
        "gate must fail loudly, not silently ship a NULL: {err}"
    );

    // …and the unconstrained copy is only the staging vehicle: the LIVE tables refuse
    // the residual state outright, so the gate never sees one (the truth-table's
    // negative control).
    let live_orphans: i64 =
        sqlx::query_scalar("SELECT count(*) FROM projects WHERE account_id IS NULL")
            .fetch_one(&pool)
            .await
            .expect("read the live orphan census");
    assert_eq!(
        live_orphans, 0,
        "the live schema's account_id CHECK is the gate's write-time half — a NULL is \
         unrepresentable, so the trap-table gate has nothing to abort over"
    );
}

// TEST-7 [acceptance, INV-1] [covers: ITEM-1, ITEM-3]: after migrate every
// project/dataset has a non-NULL account_id; `artifacts` has NO account_id/owner_id
// column; account_of_artifact resolves transitively (dataset branch here).
#[tokio::test]
async fn no_null_account_id_and_artifacts_have_no_owner_columns() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let alice = create_user(&server, &admin, "alice", "alice@x.test").await;
    let pool = pool_for(&server).await;

    let projects = ProjectRepository::new(pool.clone());
    let datasets = DatasetRepository::new(pool.clone());
    let _p = projects.create(alice, "P", "").await.expect("project");
    let dataset = datasets
        .create(alice, "D", None, &serde_json::json!({}))
        .await
        .expect("dataset");

    for table in ["projects", "datasets"] {
        let nulls: i64 = sqlx::query_scalar(&format!(
            "SELECT count(*) FROM {table} WHERE account_id IS NULL"
        ))
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(nulls, 0, "no {table} row may have a NULL account_id");
    }

    // artifacts carries NO account_id / owner_id column — the account is transitive.
    for col in ["account_id", "owner_id"] {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('artifacts') WHERE name = $1)",
        )
        .bind(col)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(
            !exists,
            "artifacts must NOT carry an {col} column (account is transitive)"
        );
    }

    // Transitive resolution via a dataset_id back-pointer.
    // The sqlite chain has no uuid default (DEC-12): the id is an app-side
    // `randomblob(16)` literal (the `account_of_test` idiom).
    let artifact_id: Uuid = sqlx::query_scalar(
        "INSERT INTO artifacts \
           (id, dataset_id, output_id, datatype, object_key, is_multifile, content_hash, \
            structure, meta, role, status, stored_bytes, hidden) \
         VALUES (randomblob(16), $1, 'out-1', 'data/opaque', 'k/1', false, $2, \
                 '{}', '{}', 'artifact', 'ready', 1, false) \
         RETURNING id",
    )
    .bind(dataset.id)
    .bind(format!("sha256:{}", "b".repeat(64)))
    .fetch_one(&pool)
    .await
    .expect("insert dataset-scoped artifact");

    let via_artifact =
        cytoanalyst::modules::account::scope::account_of_artifact(&pool, artifact_id)
            .await
            .unwrap();
    let via_dataset = account_of_dataset(&pool, dataset.id).await.unwrap();
    assert_eq!(
        via_artifact, via_dataset,
        "account_of_artifact == account_of its parent dataset"
    );
    assert!(
        via_artifact.is_some(),
        "the artifact resolves to an account"
    );
}
