//! TEST-12 [covers: ITEM-1] — the `202608240001` baseline applies: the `drafts`
//! table + `drafts_project_idx` exist, and the `drafts::use` grant is appended to the
//! Users group exactly once (idempotent re-run).

use sqlx::PgPool;

use super::*;
use crate::common::TestServer;

#[tokio::test]
async fn drafts_schema_and_grant_are_present() {
    let server = TestServer::spawn().await;
    let _admin = setup_admin(&server).await;
    let pool = PgPool::connect(server.database_url()).await.unwrap();

    // The table exists with the expected columns.
    let cols: Vec<String> = sqlx::query_scalar::<_, String>(
        "SELECT column_name::text FROM information_schema.columns \
         WHERE table_schema = 'public' AND table_name = 'drafts' ORDER BY column_name",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    for expected in [
        "id",
        "kind",
        "project_id",
        "data",
        "status",
        "frozen_artifact_id",
        "created_by",
        "created_at",
        "updated_at",
    ] {
        assert!(
            cols.iter().any(|c| c == expected),
            "drafts.{expected} column missing (have {cols:?})"
        );
    }

    // The list index exists.
    let has_index: bool = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM pg_indexes \
         WHERE schemaname = 'public' AND tablename = 'drafts' AND indexname = 'drafts_project_idx')",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(has_index, "drafts_project_idx missing");

    // The async-freeze mapping table (migration 202608240002) exists with its columns.
    let fj_cols: Vec<String> = sqlx::query_scalar::<_, String>(
        "SELECT column_name::text FROM information_schema.columns \
         WHERE table_schema = 'public' AND table_name = 'draft_freeze_jobs' ORDER BY column_name",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    for expected in ["job_id", "draft_id", "content_hash", "created_at"] {
        assert!(
            fj_cols.iter().any(|c| c == expected),
            "draft_freeze_jobs.{expected} column missing (have {fj_cols:?})"
        );
    }

    // The grant lands on the Users group EXACTLY ONCE (append-if-absent is idempotent).
    let grant_count = |pool: PgPool| async move {
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM (SELECT unnest(permissions) AS p FROM groups WHERE name = 'Users') s \
             WHERE s.p = 'drafts::use'",
        )
        .fetch_one(&pool)
        .await
        .unwrap()
    };
    assert_eq!(
        grant_count(pool.clone()).await,
        1,
        "drafts::use granted to Users exactly once"
    );

    // IDEMPOTENCY (finding 14): actually RE-RUN the migration's append-if-absent grant
    // and re-assert the count is STILL 1 — proving the `WHERE NOT (... = ANY(...))` guard
    // is a no-op on a second application (asserting count==1 after a single apply proves
    // nothing about idempotency).
    sqlx::query(
        "UPDATE public.groups SET permissions = array_append(permissions, 'drafts::use') \
         WHERE name = 'Users' AND NOT ('drafts::use' = ANY (permissions))",
    )
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        grant_count(pool.clone()).await,
        1,
        "re-running the append-if-absent grant is idempotent (still exactly one)"
    );
}

/// TEST-12 (ordering half, finding 14) — a pure filesystem check that BOTH drafts
/// migrations sort ABOVE every OTHER (non-drafts) server-sequence migration prefix, that
/// the freeze-jobs migration sorts above the baseline (its `job_id`/`draft_id` FKs apply
/// after both), and that every prefix is PREFIX-UNIQUE across all module migration dirs
/// (FK apply order depends on it; DEC-8). The desktop `1e13` block sits above every server
/// prefix on purpose and is excluded.
#[test]
fn drafts_migration_prefix_sorts_above_server_max_and_is_unique() {
    use std::path::Path;

    // The drafts migrations: the baseline table, the async-freeze mapping table, then the
    // version-lineage table (INV-7 / DEC-11).
    const DRAFTS_PREFIX: u64 = 202608240001;
    const DRAFT_FREEZE_JOBS_PREFIX: u64 = 202608240002;
    const DRAFT_LINEAGE_PREFIX: u64 = 202608240003;
    // The desktop sequence lives in a deliberate 1e13 block ABOVE every server timestamp.
    const DESKTOP_BLOCK_FLOOR: u64 = 10_000_000_000_000;

    // Walk src/modules/*/migrations/*.sql (relative to the server crate root).
    let modules = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/modules");
    let mut prefixes: Vec<u64> = Vec::new();
    let mut baseline_seen = 0usize;
    let mut freeze_jobs_seen = 0usize;
    let mut lineage_seen = 0usize;
    for module in std::fs::read_dir(&modules)
        .expect("read modules dir")
        .flatten()
    {
        let mig = module.path().join("migrations");
        let Ok(entries) = std::fs::read_dir(&mig) else {
            continue;
        };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.ends_with(".sql") {
                continue;
            }
            let prefix_str = name.split('_').next().unwrap_or("");
            let Ok(prefix) = prefix_str.parse::<u64>() else {
                continue;
            };
            if prefix == DRAFTS_PREFIX {
                baseline_seen += 1;
            }
            if prefix == DRAFT_FREEZE_JOBS_PREFIX {
                freeze_jobs_seen += 1;
            }
            if prefix == DRAFT_LINEAGE_PREFIX {
                lineage_seen += 1;
            }
            prefixes.push(prefix);
        }
    }

    assert_eq!(
        baseline_seen, 1,
        "the drafts baseline prefix {DRAFTS_PREFIX} must appear exactly once across module migrations"
    );
    assert_eq!(
        freeze_jobs_seen, 1,
        "the draft_freeze_jobs prefix {DRAFT_FREEZE_JOBS_PREFIX} must appear exactly once"
    );
    assert_eq!(
        lineage_seen, 1,
        "the draft_artifact_lineage prefix {DRAFT_LINEAGE_PREFIX} must appear exactly once"
    );
    // The freeze-jobs migration applies AFTER the baseline (its FK targets `drafts`).
    assert!(
        DRAFT_FREEZE_JOBS_PREFIX > DRAFTS_PREFIX,
        "draft_freeze_jobs {DRAFT_FREEZE_JOBS_PREFIX} must sort above the drafts baseline {DRAFTS_PREFIX}"
    );
    // The lineage migration applies AFTER the baseline (its FK targets `drafts` + `artifacts`).
    assert!(
        DRAFT_LINEAGE_PREFIX > DRAFT_FREEZE_JOBS_PREFIX,
        "draft_artifact_lineage {DRAFT_LINEAGE_PREFIX} must sort above the freeze-jobs migration {DRAFT_FREEZE_JOBS_PREFIX}"
    );
    // Prefix-uniqueness across the WHOLE server sequence (FKs depend on ordering).
    let mut server_prefixes: Vec<u64> = prefixes
        .iter()
        .copied()
        .filter(|p| *p < DESKTOP_BLOCK_FLOOR)
        .collect();
    server_prefixes.sort_unstable();
    let mut dedup = server_prefixes.clone();
    dedup.dedup();
    assert_eq!(
        dedup.len(),
        server_prefixes.len(),
        "duplicate server migration prefixes: {server_prefixes:?}"
    );
    // BOTH drafts migrations must sort above the previous (non-drafts) server max.
    let max_other = server_prefixes
        .iter()
        .copied()
        .filter(|p| {
            *p != DRAFTS_PREFIX && *p != DRAFT_FREEZE_JOBS_PREFIX && *p != DRAFT_LINEAGE_PREFIX
        })
        .max()
        .expect("at least one other server migration exists");
    assert!(
        DRAFTS_PREFIX > max_other,
        "drafts baseline {DRAFTS_PREFIX} must sort above the previous server max {max_other}"
    );
    assert!(
        DRAFT_FREEZE_JOBS_PREFIX > max_other,
        "draft_freeze_jobs {DRAFT_FREEZE_JOBS_PREFIX} must sort above the previous server max {max_other}"
    );
    assert!(
        DRAFT_LINEAGE_PREFIX > max_other,
        "draft_artifact_lineage {DRAFT_LINEAGE_PREFIX} must sort above the previous server max {max_other}"
    );
}
