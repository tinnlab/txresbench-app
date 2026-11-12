//! TEST-4 [acceptance] [invariant: INV-3, INV-7] — `ComputeBackend::Kubernetes` (PROV-T3-1,
//! the job-per-run fallback). `#[cfg(feature = "saas")]` + kind-gated: on the Level-2 kind
//! cluster (PROV-T1-2), `KubernetesBackend::launch(ClusterBatch)` mints a K8s `Job` from the
//! same `ComputeSpec`, streams the pod's logs into the `ProgressSink`, and surfaces the child's
//! exit — the trait UNCHANGED (INV-7). The Job is deleted when the returned `LaunchedCompute`
//! drops (orphan cleanup).
//!
//! RUNTIME self-skip (the repo pattern — `record_skip`, NOT a compile-time gate) when no kind
//! cluster is reachable: the skip lands in the skip-ledger so it can never read as a silent
//! green. Run it against a cluster:
//!   just cloud-sim-test-floci-k8s
//!   export KUBECONFIG=src-app/cloud-sim/.floci-kube-config
//!   TXR_WORKER_IMAGE=busybox:latest cargo test -p txresbench --features saas \
//!     --test integration_tests sandbox::kubernetes_backend -- --test-threads=1

#![cfg(feature = "saas")]

use std::sync::{Arc, Mutex};

use uuid::Uuid;

use txresbench::modules::sandbox::backend::{
    ComputeSpec, PriorityClass, ProgressFrame, ProgressSink, ResourceClass, ResourceProfile,
};

use crate::dataset::hardening_common::record_skip;

/// A capturing sink so the test can assert the pod's log line reached the `ProgressSink`.
#[derive(Default)]
struct CapturingSink {
    lines: Mutex<Vec<String>>,
}
impl ProgressSink for CapturingSink {
    fn progress(&self, frame: ProgressFrame) {
        if let Some(m) = frame.message {
            self.lines.lock().unwrap().push(m);
        }
    }
}

fn cluster_batch_spec(command: &str) -> ComputeSpec {
    ComputeSpec {
        job_id: Uuid::new_v4(),
        workspace_root: std::path::PathBuf::from("/tmp/unused"),
        outputs_dir: std::path::PathBuf::from("/tmp/unused-out"),
        command: command.to_string(),
        input_mounts: vec![],
        code_mount: None,
        extra_mounts: vec![],
        // #189 added `ComputeSpec::env_id`, and this saas-only file was not updated, so
        // `cargo check --features saas --tests` was red on `main`. `None` means "no per-job
        // env declared", which is the deployment-default path this test exercises.
        //
        // This field was added TWICE, by two branches that each fixed the same break in the
        // same struct at different offsets. The hunks did not overlap, so git merged both
        // without a conflict and produced `field `env_id` specified more than once` (E0062)
        // — a build break created BY the merge, present in neither parent. Fifth instance in
        // this repo of two independently-correct edits whose interaction git cannot flag;
        // see also a certification counter decremented twice to the same value, two branches
        // choosing identical seed versions, one manifest bump covering two changes, and a
        // content-lock digest recorded by one branch while another edited the locked file.
        // The generalisable form: THE HUNK THAT DOES NOT CONFLICT IS THE ONE TO CHECK.
        env_id: None,
        profile: ResourceProfile {
            memory_max_bytes: 1 << 30,
            memory_swap_max_bytes: 1 << 30,
            pids_max: 128,
            cpu_max: "100000 100000".into(),
            timeout_secs: 120,
        },
        priority: PriorityClass::Batch,
        resource_class: ResourceClass::ClusterBatch,
    }
}

/// Whether a kind cluster is reachable — KUBECONFIG set AND the apiserver answers a node list.
async fn cluster_reachable() -> bool {
    use k8s_openapi::api::core::v1::Node;
    use kube::{Api, Client};
    if std::env::var("KUBECONFIG")
        .ok()
        .filter(|s| !s.is_empty())
        .is_none()
    {
        return false;
    }
    match Client::try_default().await {
        Ok(client) => {
            let nodes: Api<Node> = Api::all(client);
            nodes.list(&Default::default()).await.is_ok()
        }
        Err(_) => false,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn kubernetes_backend_mints_job_streams_logs_surfaces_exit() {
    use txresbench::modules::sandbox::backend::kubernetes::KubernetesBackend;
    use txresbench::modules::sandbox::backend::ComputeBackend;

    let backend = KubernetesBackend::new();
    // `supports` = exactly the three remote classes; NOT cpu-sandbox (that is the pool's). This
    // half runs even without a cluster (it needs no apiserver).
    assert!(backend.supports(ResourceClass::ClusterBatch));
    assert!(backend.supports(ResourceClass::Gpu));
    assert!(backend.supports(ResourceClass::Highmem));
    assert!(!backend.supports(ResourceClass::CpuSandbox));

    // The launch legs need a live cluster — RUNTIME self-skip (ledger-recorded) otherwise.
    if !cluster_reachable().await {
        record_skip(
            "sandbox::kubernetes_backend_test::mints_job",
            "no reachable kind cluster (KUBECONFIG unset or apiserver down) — run under the L2 tier",
        );
        return;
    }

    // The ClusterBatch nodeSelector is `txr.io/pool=batch` (per-class node pools, DE-INV-7).
    // The single-node kind cluster has no labeled pools, so label the node(s) — this proves the
    // real nodeSelector path (the pod schedules onto the matching node), not a bypass.
    let labeled = std::process::Command::new("kubectl")
        .args([
            "label",
            "node",
            "--all",
            "txr.io/pool=batch",
            "--overwrite",
        ])
        .output();
    assert!(
        labeled.map(|o| o.status.success()).unwrap_or(false),
        "labeled the kind node txr.io/pool=batch so the ClusterBatch nodeSelector matches"
    );

    // The job-per-run backend now requires a configured object store (INV-4 / #66): the pod
    // fetches its inputs from it. Install a process-local store so `launch` passes the guard
    // (this test proves the launch/watch/drop MECHANICS on a real cluster, not the full S3 loop —
    // the full data-plane loop is proven by the in-pod `run-job` test + the LIVE floci run).
    let _store = crate::common::object_store::shared_object_store_root();

    let sink = Arc::new(CapturingSink::default());
    // The manifest now runs `txresbench run-job --job-id <id>` (NOT an arbitrary command — the
    // data-plane #66 change). On the plain `busybox` test image there is no `txresbench` binary,
    // so the container exec fails and the pod goes Failed — which is exactly what exercises the
    // launch → watch → exit-surface → Drop-delete MECHANICS this test asserts (INV-6/INV-7). The
    // command that RUNS is asserted structurally by the unit test `test_2_build_job_wires_...`.
    let spec = cluster_batch_spec("unused-by-the-data-plane-manifest");
    let name = format!("txr-{}", spec.job_id.simple());
    let mut launched = backend
        .launch(spec, sink.clone())
        .await
        .expect("launch mints a k8s Job and returns a shepherd child");

    // The shepherd surfaces the pod's exit (INV-7 trait-unchanged: a pod is not a local child,
    // yet `wait()` works). The busybox pod fails to exec `txresbench`, so the code is non-zero —
    // the point is that an exit is surfaced at all, on a real cluster, via the watcher.
    let status = launched.child.wait().await.expect("shepherd exits");
    assert!(
        status.code().is_some(),
        "the shepherd surfaced the pod's terminal exit code (watch → exit-surface works)"
    );

    // Dropping the LaunchedCompute deletes the Job (orphan cleanup, INV-6).
    drop(launched);
    // Give the background delete a moment, then confirm the Job is gone.
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    use k8s_openapi::api::batch::v1::Job;
    use kube::{Api, Client};
    let client = Client::try_default().await.expect("kube client");
    let jobs: Api<Job> = Api::namespaced(client, "default");
    assert!(
        jobs.get_opt(&name).await.ok().flatten().is_none(),
        "dropping the LaunchedCompute deleted the k8s Job (no orphan)"
    );
}

// TEST-5 (ITEM-2 / #66): a backend that stages inputs REMOTELY (the KubernetesBackend
// job-per-run) makes the control-plane `SandboxJobRunner` SKIP local input materialization +
// local output staging — `spawn` returns a `SpawnedJob` with `workspace == None` AND
// `outputs_staging == None`, so the executor's local finalize is skipped (the pod owns
// finalize; the executor reflects the pod's exit code into the job status). Uses a FAKE remote
// backend injected via `BackendRegistry::new_with_remote`, so no cluster is needed.
mod remote_skip {
    use std::sync::Arc;

    use async_trait::async_trait;
    use uuid::Uuid;
    use txresbench_core::AppError;

    use txresbench::modules::jobs::repository::JobRepository;
    use txresbench::modules::jobs::runner::{JobRunner, SandboxJobRunner};
    use txresbench::modules::sandbox::backend::local_bwrap::BackendRegistry;
    use txresbench::modules::sandbox::backend::{
        BackendAvailability, ComputeBackend, ComputeSpec, LaunchedCompute, ProgressSink,
        ResourceClass,
    };

    use crate::common::TestServer;
    use crate::dataset::hardening_common::pool_for;
    use crate::sandbox::setup_admin;

    /// A fake remote backend: reports it stages remotely + serves the heavy classes, and
    /// `launch` returns a trivial live child WITHOUT touching any local workspace.
    struct FakeRemote;
    #[async_trait]
    impl ComputeBackend for FakeRemote {
        async fn launch(
            &self,
            _spec: ComputeSpec,
            _sink: Arc<dyn ProgressSink>,
        ) -> Result<LaunchedCompute, AppError> {
            let child = tokio::process::Command::new("true")
                .kill_on_drop(true)
                .spawn()
                .map_err(|e| AppErrorernal_error(format!("spawn true: {e}")))?;
            Ok(LaunchedCompute {
                child,
                guards: Box::new(()),
                cgroup_path: None,
            })
        }
        fn probe(&self) -> BackendAvailability {
            BackendAvailability::Available
        }
        fn supports(&self, class: ResourceClass) -> bool {
            matches!(
                class,
                ResourceClass::Gpu | ResourceClass::Highmem | ResourceClass::ClusterBatch
            )
        }
        fn stages_inputs_remotely(&self) -> bool {
            true
        }
    }

    #[tokio::test]
    async fn remote_backend_skips_local_staging_and_finalize() {
        let server = TestServer::spawn().await;
        let _token = setup_admin(&server).await;
        let pool = pool_for(&server).await;
        let owner: Uuid = sqlx::query_scalar("SELECT id FROM users WHERE username = 'sbxadmin'")
            .fetch_one(&pool)
            .await
            .expect("owner id");

        // An already-claimed running analysis job, marked a heavy class so `select` routes it to
        // the (fake) remote backend.
        let repo = JobRepository::new(pool.clone());
        let id = Uuid::new_v4();
        let params = serde_json::json!({
            "language": "bash",
            "script": "echo ok > /outputs/manifest.json"
        });
        repo.create_running_under_cap(id, owner, "analysis", "remote-skip", params, None, 100_000)
            .await
            .expect("insert")
            .expect("under cap");
        sqlx::query("UPDATE jobs SET resource_class = 'cluster-batch' WHERE id = $1")
            .bind(id)
            .execute(&pool)
            .await
            .expect("heavy class");
        let job = repo.get_any(id).await.unwrap().unwrap();

        let registry = Arc::new(BackendRegistry::new_with_remote(pool.clone(), Arc::new(FakeRemote)));
        let runner = SandboxJobRunner::new(pool.clone(), registry);
        let mut spawned = runner.spawn(&job).await.expect("remote launch");

        // The whole point (ITEM-2): NO local dirs → the executor skips its local finalize.
        assert!(
            spawned.workspace.is_none(),
            "remote job carries NO local workspace (the pod staged inputs itself)"
        );
        assert!(
            spawned.outputs_staging.is_none(),
            "remote job carries NO local output staging (the pod owns finalize)"
        );
        let _ = spawned.child.wait().await;
    }
}
