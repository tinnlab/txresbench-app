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
        let is_nullable: String = sqlx::query_scalar(
            "SELECT is_nullable FROM information_schema.columns \
             WHERE table_schema='public' AND table_name=$1 AND column_name='account_id'",
        )
        .bind(table)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|_| panic!("{table}.account_id must exist"));
        assert_eq!(is_nullable, "NO", "{table}.account_id must be NOT NULL");

        let (del_type, referenced): (String, String) = sqlx::query_as(
            "SELECT confdeltype, confrelid::regclass \
             FROM pg_constraint WHERE conname = $1",
        )
        .bind(format!("{table}_account_id_fkey"))
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|_| panic!("{table}_account_id_fkey must exist"));
        // 'a' = NO ACTION (Postgres pg_constraint.confdeltype).
        assert_eq!(del_type, "a", "{table} FK must be NO ACTION");
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
            "SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname=$1",
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
            "UPDATE projects p SET account_id = a.id FROM accounts a \
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

    // Zero-orphan gate: force a residual NULL and prove the DO-block RAISEs.
    sqlx::query("ALTER TABLE projects ALTER COLUMN account_id DROP NOT NULL")
        .execute(&pool)
        .await
        .expect("drop not null (test-local, disposable DB)");
    sqlx::query(
        "INSERT INTO projects (id, owner_id, account_id, name, description) \
         VALUES (randomblob(16), $1, NULL, 'orphan', '')",
    )
    .bind(alice)
    .execute(&pool)
    .await
    .expect("insert an orphan row");

    let gate = sqlx::query(
        "DO $$ BEGIN \
           IF EXISTS (SELECT 1 FROM public.projects WHERE account_id IS NULL) \
              OR EXISTS (SELECT 1 FROM public.datasets WHERE account_id IS NULL) THEN \
             RAISE EXCEPTION 'account backfill left orphaned rows'; \
           END IF; \
         END $$;",
    )
    .execute(&pool)
    .await;
    let err = gate.expect_err("the zero-orphan gate must RAISE on a residual NULL");
    assert!(
        err.to_string().contains("orphaned rows"),
        "gate must fail loudly, not silently ship a NULL: {err}"
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
            "SELECT count(*) FROM public.{table} WHERE account_id IS NULL"
        ))
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(nulls, 0, "no {table} row may have a NULL account_id");
    }

    // artifacts carries NO account_id / owner_id column — the account is transitive.
    for col in ["account_id", "owner_id"] {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM information_schema.columns \
             WHERE table_schema='public' AND table_name='artifacts' AND column_name=$1)",
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
    let artifact_id: Uuid = sqlx::query_scalar(
        "INSERT INTO artifacts \
           (dataset_id, output_id, datatype, object_key, is_multifile, content_hash, \
            structure, meta, role, status, stored_bytes, hidden) \
         VALUES ($1, 'out-1', 'data/opaque', 'k/1', false, $2, \
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
