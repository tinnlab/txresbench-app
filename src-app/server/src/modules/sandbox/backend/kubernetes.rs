//! `ComputeBackend::Kubernetes` — the job-per-run FALLBACK topology (T3 / ITEM-6, §4.2).
//!
//! **`#[cfg(feature = "saas")]` only** (INV-3): this module + the `kube`/`k8s-openapi`
//! client crates are physically ABSENT from a `--no-default-features` desktop build. Core
//! reaches it ONLY through the `BackendRegistry::select` seam (`local_bwrap.rs:161`), so the
//! seam that makes it swappable is the seam that makes it absent when the `saas` cargo feature is off.
//!
//! The DEFAULT topology is worker-pod-runs-Local (a persistent pool of `cytoanalyst worker`
//! Deployments claiming from the queue and running the UNCHANGED `LocalBwrapBackend`
//! in-process — see `run_worker` + the worker Deployment). This backend is the fallback for
//! `ResourceClass::{Gpu, Highmem, ClusterBatch}`, where per-run node placement must be
//! dynamic: `launch` mints a K8s `Job` from the same `ComputeSpec` (image = the worker image,
//! `nodeSelector` per class), streams the pod's logs into the `ProgressSink`, and surfaces the
//! child's exit — the trait is UNCHANGED (INV-7).
//!
//! ### Fitting the `LaunchedCompute` (local-`Child`) contract
//! The executor drives a `tokio::process::Child` (`try_wait`/`wait`/kill). A pod is not a
//! local child, so `launch` returns a local **shepherd** `sh` process that blocks on a
//! done-marker file and exits with the pod's recorded exit code; a background watcher task
//! creates+watches the Job, drains its logs, then writes the code + marker. The returned
//! guard's `Drop` aborts the watcher and best-effort DELETES the Job (orphan cleanup), so a
//! dropped `LaunchedCompute` never leaves a Job running on the cluster.

use std::sync::Arc;

use async_trait::async_trait;
use k8s_openapi::api::batch::v1::{Job, JobSpec};
use k8s_openapi::api::core::v1::{
    Container, EmptyDirVolumeSource, EnvFromSource, EnvVar, PodSpec, PodTemplateSpec,
    SecretEnvSource, SecretVolumeSource, SecurityContext, Volume, VolumeMount,
};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use kube::api::{DeleteParams, ListParams, PostParams};
use kube::{Api, Client};
use ziee_core::AppError;

use super::{
    backend_unavailable, BackendAvailability, ComputeBackend, ComputeSpec, LaunchedCompute,
    ProgressFrame, ProgressSink, ResourceClass,
};

/// The Kubernetes job-per-run backend. Holds the ENV-default namespace + worker image
/// and, optionally, the DB pool so the admin infra config (#63) is resolved READ-AT-USE
/// at launch (a PUT of namespace/worker-image takes effect on the next job, no restart;
/// INV-5, env fallback). A fresh `kube::Client` is created per `launch`/`probe` (it is
/// cheap and picks up the ambient `KUBECONFIG` / in-cluster config).
pub struct KubernetesBackend {
    /// Env-default namespace (the fallback when no DB row configures one).
    namespace: String,
    /// Env-default worker/job image (fallback).
    image: String,
    /// DB pool for the read-at-use infra config (#63). `None` ⇒ env-only (tests / the
    /// pool-less construction path).
    pool: Option<sqlx::PgPool>,
}

impl Default for KubernetesBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl KubernetesBackend {
    pub fn new() -> Self {
        Self {
            namespace: std::env::var("CYTO_K8S_NAMESPACE").unwrap_or_else(|_| "default".into()),
            // The worker image also serves as the job-per-run image (it carries the runtime).
            image: std::env::var("CYTO_WORKER_IMAGE")
                .unwrap_or_else(|_| "cytoanalyst-worker:latest".into()),
            pool: None,
        }
    }

    /// Construct with explicit namespace + image (no DB read). Used where the effective
    /// values are already resolved.
    pub fn from_config(namespace: String, image: String) -> Self {
        Self { namespace, image, pool: None }
    }

    /// Construct with the DB pool so the admin infra config (#63) is resolved READ-AT-USE
    /// at launch (namespace + worker-image DB-else-env; INV-5). The env values seed the
    /// fallback.
    pub fn with_pool(pool: sqlx::PgPool) -> Self {
        Self { pool: Some(pool), ..Self::new() }
    }

    /// The effective (namespace, image) at call time: the DB row (#63) layered over the
    /// env defaults, or the env defaults when no pool / no row. Read-at-use.
    async fn effective(&self) -> (String, String) {
        match &self.pool {
            Some(pool) => {
                crate::modules::sandbox::infra_compute::effective_namespace_image(
                    pool,
                    &self.namespace,
                    &self.image,
                )
                .await
            }
            None => (self.namespace.clone(), self.image.clone()),
        }
    }

    /// The `nodeSelector` for a resource class (dynamic per-run node placement — DE-INV-7).
    /// `None` for cpu-sandbox (this backend never serves it — the pool does).
    fn node_selector(class: ResourceClass) -> Option<std::collections::BTreeMap<String, String>> {
        let label = match class {
            ResourceClass::Gpu => "gpu",
            ResourceClass::Highmem => "highmem",
            ResourceClass::ClusterBatch => "batch",
            ResourceClass::CpuSandbox => return None,
        };
        let mut m = std::collections::BTreeMap::new();
        m.insert("cyto.io/pool".to_string(), label.to_string());
        Some(m)
    }

    /// Build the K8s `Job` manifest from a `ComputeSpec` — the job-per-run DATA PLANE (#66).
    ///
    /// The pod runs `cytoanalyst run-job --job-id <id>` (NOT the raw `spec.command`): that in-pod
    /// entrypoint re-fetches the job's content-addressed inputs from the object store into its
    /// local workspace, runs the analysis under bwrap+squashfuse, and pushes the outputs back to
    /// the object store + catalog — reusing the SAME `materialize_inputs` + `finalize_analysis`
    /// as the worker-pod path (so the inputs.json / `/outputs` contract is identical, INV-1/2).
    ///
    /// The pod carries the deploy-spike deployment shape (#67): a `securityContext.privileged` (for
    /// squashfuse's `/dev/fuse`), an `emptyDir` scratch workspace, the env-rootfs squashfs
    /// (delivered by an optional init-container into a shared `emptyDir`, or baked into the
    /// image), and the DB/object-store config (a mounted config Secret + an optional env Secret).
    /// `restartPolicy: Never` + `backoffLimit: 0` so a failed run surfaces as a failed Job (no
    /// silent retry); `nodeSelector` pins the class's pool.
    fn build_job(&self, spec: &ComputeSpec, name: &str, namespace: &str, image: &str) -> Job {
        let shape = PodShape::from_env();

        // The env-rootfs squashfs lives under the app-data dir at a shared sub-path so an
        // init-container fetch and the main container agree on ONE location.
        let env_rootfs_dir = format!("{}/env-rootfs", shape.app_data_dir);
        let env_rootfs_squashfs = format!("{env_rootfs_dir}/rootfs.squashfs");

        // #189 — the env THIS job runs in: its declared env, else the deployment default.
        //
        // The pod re-enters via `run-job --job-id` and resolves its env from the process
        // environment, so `CYTO_SANDBOX_ENV_ID` below is the ONLY channel by which a
        // per-job env reaches the actual run. It is used for BOTH the main container and
        // the rootfs-fetcher init-container: if those two disagreed, the init container
        // would prefetch one env's rootfs and the main container would resolve a
        // different one — mounting the wrong image with nothing reporting it.
        //
        // The precedence (operator override > declared env > deployment default) lives in
        // ONE place, `env_image::resolve_env_id`, rather than being re-spelled per
        // backend — two backends disagreeing about which env wins is a difference nothing
        // would surface until a job ran in the wrong image on one topology only.
        // No `.or_else` fallback here: `resolve_env_id(None)` already subsumes everything
        // a deployment-wide default could contribute (the operator override, the settings
        // row, the registry union), so a second fallback would be unreachable code that
        // READS like a second precedence spelling — the exact thing the note above says
        // must not exist.
        let job_env_id = crate::modules::sandbox::env_image::resolve_env_id(spec.env_id.as_deref());

        // Main-container env: the config file, the app-data root, the env-rootfs delivery, the
        // env-id, and the scheduler-off belt (run_job_once also sets it, in-process).
        let mut env = vec![
            env_var("CONFIG_FILE", &shape.config_file),
            env_var("CYTO_APP_DATA_DIR", &shape.app_data_dir),
            env_var("CYTO_ENV_ROOTFS_SQUASHFS", &env_rootfs_squashfs),
            env_var("CYTO_SCHEDULER_ENABLED", "off"),
        ];
        // Omitted entirely when nothing declares an env, rather than stamped with an
        // invented name: the in-pod resolver then reports "no env declared" instead of
        // failing to pull a repo that never existed.
        if let Some(id) = job_env_id.as_deref() {
            env.push(env_var("CYTO_SANDBOX_ENV_ID", id));
        }

        // Volumes: app-data scratch (workspace + output staging), the shared env-rootfs volume,
        // and the config Secret.
        let volumes = vec![
            Volume {
                name: "app-data".into(),
                empty_dir: Some(EmptyDirVolumeSource::default()),
                ..Default::default()
            },
            Volume {
                name: "env-rootfs".into(),
                empty_dir: Some(EmptyDirVolumeSource::default()),
                ..Default::default()
            },
            Volume {
                name: "worker-config".into(),
                secret: Some(SecretVolumeSource {
                    secret_name: Some(shape.config_secret.clone()),
                    // Optional so a MISSING config Secret yields a clean `run-job` failure (it
                    // boots, cannot load its DB config, exits non-zero → the job fails with a
                    // reason) rather than a pod wedged in ContainerCreating until the deadline.
                    optional: Some(true),
                    ..Default::default()
                }),
                ..Default::default()
            },
        ];

        let volume_mounts = vec![
            VolumeMount {
                name: "app-data".into(),
                mount_path: shape.app_data_dir.clone(),
                ..Default::default()
            },
            VolumeMount {
                name: "env-rootfs".into(),
                mount_path: env_rootfs_dir.clone(),
                ..Default::default()
            },
            VolumeMount {
                name: "worker-config".into(),
                mount_path: shape.config_dir.clone(),
                read_only: Some(true),
                ..Default::default()
            },
        ];

        // Optional env-from Secret: AWS_* static creds + CYTO_WORKSTORE_* selection (the custom
        // S3 endpoint itself is release-safe via the DB `infra_object_store` row, #63 — NOT env).
        let env_from = shape.env_secret.as_ref().map(|s| {
            vec![EnvFromSource {
                secret_ref: Some(SecretEnvSource {
                    name: s.clone(),
                    optional: Some(true),
                }),
                ..Default::default()
            }]
        });

        let container = Container {
            name: "run".into(),
            image: Some(image.to_string()),
            command: Some(vec![
                "cytoanalyst".into(),
                "run-job".into(),
                "--job-id".into(),
                spec.job_id.to_string(),
            ]),
            env: Some(env),
            env_from,
            volume_mounts: Some(volume_mounts),
            security_context: Some(SecurityContext {
                privileged: Some(shape.privileged),
                ..Default::default()
            }),
            ..Default::default()
        };

        // Optional init-container that FETCHES the env-rootfs squashfs into the shared volume
        // before the main container starts (the air-gap / GHCR-private delivery path). When no
        // fetcher image is configured, the rootfs is expected baked into the worker image.
        let init_containers = shape.env_rootfs_fetcher_image.as_ref().map(|img| {
            // The SAME `job_env_id` the main container gets — see its note above for why
            // the two must not be resolved independently.
            let mut init_env = Vec::new();
            if let Some(id) = job_env_id.as_deref() {
                init_env.push(env_var("CYTO_SANDBOX_ENV_ID", id));
            }
            // The fetcher writes the squashfs here (the volume is shared with main).
            init_env.push(env_var("CYTO_ENV_ROOTFS_OUT", "/env-rootfs/rootfs.squashfs"));
            vec![Container {
                name: "fetch-env-rootfs".into(),
                image: Some(img.clone()),
                env: Some(init_env),
                volume_mounts: Some(vec![VolumeMount {
                    name: "env-rootfs".into(),
                    mount_path: "/env-rootfs".into(),
                    ..Default::default()
                }]),
                ..Default::default()
            }]
        });

        let pod_spec = PodSpec {
            containers: vec![container],
            init_containers,
            volumes: Some(volumes),
            restart_policy: Some("Never".into()),
            node_selector: Self::node_selector(spec.resource_class),
            ..Default::default()
        };
        let mut labels = std::collections::BTreeMap::new();
        labels.insert("app".to_string(), "cyto-compute-job".to_string());
        labels.insert("cyto.io/job-id".to_string(), spec.job_id.to_string());
        Job {
            metadata: ObjectMeta {
                name: Some(name.to_string()),
                namespace: Some(namespace.to_string()),
                labels: Some(labels.clone()),
                ..Default::default()
            },
            spec: Some(JobSpec {
                backoff_limit: Some(0),
                // K8s-enforced whole-run wall-clock (analysis budget + staging/upload slack): the
                // PRIMARY deadline, so a truly-stuck pod is reaped by the cluster itself rather
                // than only by the server-side watcher. Set from the resolved job budget so a
                // long heavy job is not capped by a fixed short ceiling (#66 audit FIX-1).
                active_deadline_seconds: Some(job_deadline_secs(spec)),
                // Reap the Job object shortly after it finishes (defense-in-depth on top of
                // the Drop-guard delete — a crashed server still gets server-side cleanup).
                ttl_seconds_after_finished: Some(120),
                template: PodTemplateSpec {
                    metadata: Some(ObjectMeta {
                        labels: Some(labels),
                        ..Default::default()
                    }),
                    spec: Some(pod_spec),
                },
                ..Default::default()
            }),
            ..Default::default()
        }
    }
}

/// The pod's whole-run wall-clock deadline (seconds): the resolved ANALYSIS budget
/// (`profile.timeout_secs`) plus slack for the pod's own input STAGING + output UPLOAD (which the
/// in-pod `run-job` does around the analysis, and which the analysis budget does not cover).
/// Slack is env-tunable (`CYTO_K8S_JOB_DEADLINE_SLACK_SECS`, default 900s). This is the SINGLE
/// source of truth for the Job's `activeDeadlineSeconds`, the watcher ceiling, and the shepherd
/// cap — so a legitimately long heavy job (the workload class this backend exists for) is NOT
/// force-killed by a fixed short ceiling. `activeDeadlineSeconds` makes k8s itself the primary
/// wall-clock enforcer; the watcher/shepherd ceilings are set generously ABOVE it so k8s reaps
/// first (a Failed status the watcher then observes), never the watcher timing out mid-run.
fn job_deadline_secs(spec: &ComputeSpec) -> i64 {
    let slack: i64 = std::env::var("CYTO_K8S_JOB_DEADLINE_SLACK_SECS")
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .filter(|&s: &i64| s >= 0)
        .unwrap_or(900);
    // Saturating: an enormous configured timeout must not overflow the i64 the k8s field takes.
    (spec.profile.timeout_secs as i64).saturating_add(slack).max(1)
}

/// A `k8s_openapi` `EnvVar` with a literal value.
fn env_var(name: &str, value: &str) -> EnvVar {
    EnvVar {
        name: name.to_string(),
        value: Some(value.to_string()),
        ..Default::default()
    }
}

/// The DEPLOYMENT pod-shape knobs for the job-per-run pod (DEC-5), resolved read-at-use from env
/// with defaults that reproduce the committed `worker-deployment.scaffold.yaml` (#67 / deploy-spike).
/// Held as one struct so a later promotion to a DB `infra_compute` column needs no call-site
/// rewrite.
struct PodShape {
    /// `securityContext.privileged` on the run container (squashfuse `/dev/fuse`). Default `true`
    /// (deploy-spike requirement); set `CYTO_K8S_PRIVILEGED=false` for a fuse-device-plugin prod.
    privileged: bool,
    /// The Secret mounted at `config_dir` carrying `config.yaml` (external Postgres + jwt +
    /// at-rest key). Default `cyto-worker-config`.
    config_secret: String,
    /// Optional Secret projected as env (AWS_* creds + `CYTO_WORKSTORE_*`). `None` ⇒ config +
    /// the DB `infra_object_store` row provide the store config.
    env_secret: Option<String>,
    /// Optional env-rootfs fetcher init-container image. `None` ⇒ rootfs baked into the worker image.
    env_rootfs_fetcher_image: Option<String>,
    // There is deliberately NO `env_id` field here (#189). It used to hold a
    // deployment-wide env-id defaulting to the literal `"cyto-default"` — an env name
    // typed into the app core (INV-4) and a DANGLING one, since no such recipe exists
    // under `src-app/env-rootfs/`, so a pod launched with it asked the registry for a
    // repo that was never published. The env a pod runs is now resolved PER JOB by
    // `env_image::resolve_env_id`, which owns the whole precedence chain; a copy of the
    // deployment default here would be a second, silently divergent spelling of it.
    /// The in-pod app-data root (`CYTO_APP_DATA_DIR`) — scratch workspace + output staging + the
    /// env-rootfs sub-dir. Default `/var/lib/cytoanalyst`.
    app_data_dir: String,
    /// The dir the config Secret mounts at. Default `/etc/cytoanalyst`.
    config_dir: String,
    /// The config file path (`CONFIG_FILE`), `<config_dir>/config.yaml`.
    config_file: String,
}

impl PodShape {
    fn from_env() -> Self {
        let config_dir =
            std::env::var("CYTO_K8S_CONFIG_DIR").unwrap_or_else(|_| "/etc/cytoanalyst".into());
        let config_file = format!("{config_dir}/config.yaml");
        Self {
            privileged: std::env::var("CYTO_K8S_PRIVILEGED")
                .ok()
                .map(|v| {
                    !matches!(
                        v.trim().to_ascii_lowercase().as_str(),
                        "0" | "false" | "no" | "off"
                    )
                })
                .unwrap_or(true),
            config_secret: std::env::var("CYTO_K8S_CONFIG_SECRET")
                .unwrap_or_else(|_| "cyto-worker-config".into()),
            env_secret: std::env::var("CYTO_K8S_ENV_SECRET")
                .ok()
                .filter(|s| !s.trim().is_empty()),
            env_rootfs_fetcher_image: std::env::var("CYTO_ENV_ROOTFS_FETCHER_IMAGE")
                .ok()
                .filter(|s| !s.trim().is_empty()),
            app_data_dir: std::env::var("CYTO_APP_DATA_DIR")
                .unwrap_or_else(|_| "/var/lib/cytoanalyst".into()),
            config_dir,
            config_file,
        }
    }
}

/// Drop guard for a launched Job: aborts the log/watch task and best-effort deletes the Job
/// so a dropped `LaunchedCompute` never orphans a running Job on the cluster.
struct JobGuard {
    watcher: tokio::task::JoinHandle<()>,
    api: Api<Job>,
    name: String,
    // Temp dir holding the done-marker + exit-code files; removed on drop.
    tmp: std::path::PathBuf,
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        self.watcher.abort();
        let _ = std::fs::remove_dir_all(&self.tmp);
        let api = self.api.clone();
        let name = self.name.clone();
        // Drop is sync: fire a detached background delete (background propagation reaps pods).
        tokio::spawn(async move {
            let _ = api.delete(&name, &DeleteParams::background()).await;
        });
    }
}

#[async_trait]
impl ComputeBackend for KubernetesBackend {
    async fn launch(
        &self,
        spec: ComputeSpec,
        sink: Arc<dyn ProgressSink>,
    ) -> Result<LaunchedCompute, AppError> {
        // INV-4 (#66 / #61): the job-per-run pod re-fetches its inputs from the object store, so
        // remote compute REQUIRES a reachable object store. Refuse with a clear reason BEFORE
        // minting a Job, rather than launching a pod that would run on empty inputs.
        if crate::modules::workstore::try_get_object_store().is_none() {
            return Err(backend_unavailable(
                "the Kubernetes job-per-run backend requires a configured object store: the \
                 remote pod fetches its inputs from + writes its outputs to the object store, so \
                 there is nothing for it to run against without one. Configure a cloud object \
                 store (admin object-store settings, #63).",
            ));
        }

        // Read-at-use effective config (#63): DB row (namespace/worker-image) layered over
        // env, so an admin PUT takes effect on THIS launch without a restart (INV-5).
        let (namespace, image) = self.effective().await;

        let client = Client::try_default()
            .await
            .map_err(|e| backend_unavailable(format!("kube client init: {e}")))?;
        let api: Api<Job> = Api::namespaced(client.clone(), &namespace);

        let name = format!("cyto-{}", spec.job_id.simple());
        let job = self.build_job(&spec, &name, &namespace, &image);
        api.create(&PostParams::default(), &job)
            .await
            .map_err(|e| backend_unavailable(format!("create k8s Job: {e}")))?;

        // Watcher/shepherd ceilings derive from the SAME deadline as the Job's
        // `activeDeadlineSeconds`, set ABOVE it (+120s) so k8s reaps a stuck pod first (a Failed
        // status the watcher observes) rather than the watcher/shepherd timing out mid-run and
        // killing a still-healthy long job (#66 audit FIX-1).
        let watch_ceiling_secs = (job_deadline_secs(&spec) as u64).saturating_add(120);

        // Temp dir for the shepherd's IPC files (done marker + exit code). std-only (no new
        // dep); removed by the guard's Drop.
        let tmp = std::env::temp_dir().join(format!("cyto-k8s-{}", spec.job_id.simple()));
        std::fs::create_dir_all(&tmp)
            .map_err(|e| backend_unavailable(format!("shepherd tmp dir: {e}")))?;
        let done_path = tmp.join("done");
        let code_path = tmp.join("code");

        // Watcher: stream pod logs into the sink, wait for terminal Job status, write the
        // exit code + the done marker (the shepherd is blocked on the marker).
        let watch_api = api.clone();
        let ns = namespace.clone();
        let name_w = name.clone();
        let done_w = done_path.clone();
        let code_w = code_path.clone();
        let watcher = tokio::spawn(async move {
            let exit =
                watch_job_to_exit(client, watch_api, &ns, &name_w, sink, watch_ceiling_secs).await;
            // Record the exit code, THEN the done marker (ordering: the shepherd only reads
            // the code after it sees the marker).
            let _ = tokio::fs::write(&code_w, exit.to_string()).await;
            let _ = tokio::fs::write(&done_w, b"1").await;
        });

        // The shepherd: a local child that blocks on the done marker and exits with the pod's
        // code, so the executor's `try_wait`/`wait`/exit-surface all work unchanged. A hard cap
        // on the wait so the shepherd can NEVER outlive the run: if the guard's Drop aborts the
        // watcher + removes the marker files before `done` is written, the shepherd would
        // otherwise spin forever waiting on a file that will never appear. `kill_on_drop` is the
        // belt (dropping `LaunchedCompute` kills the shepherd); this loop bound is the braces.
        // The cap derives from the job deadline (+60s past the watcher ceiling) so it outlasts a
        // legitimately long heavy job instead of a fixed ~15min (#66 audit FIX-1).
        let shepherd_max_iters = watch_ceiling_secs.saturating_add(60).saturating_mul(5);
        let script = format!(
            "n=0; while [ ! -e '{done}' ]; do sleep 0.2; n=$((n+1)); [ $n -gt {max} ] && exit 1; done; exit \"$(cat '{code}' 2>/dev/null || echo 1)\"",
            done = done_path.display(),
            code = code_path.display(),
            max = shepherd_max_iters,
        );
        let child = tokio::process::Command::new("sh")
            .arg("-c")
            .arg(script)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            // Die with the executor: if `LaunchedCompute` is dropped without the executor
            // draining the child (cancel / executor error), the shepherd is SIGKILLed rather
            // than leaked (the marker files it waits on are removed by the guard's Drop).
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| backend_unavailable(format!("spawn shepherd: {e}")))?;

        Ok(LaunchedCompute {
            child,
            guards: Box::new(JobGuard {
                watcher,
                api,
                name,
                tmp,
            }),
            // No local cgroup scope (compute runs in the pod) — the teardown metrics seam
            // reads `None` and records zero cpu/wall for a job-per-run today.
            cgroup_path: None,
        })
    }

    fn probe(&self) -> BackendAvailability {
        // Synchronous probe: report reachable-config-present. A full round-trip would need
        // async; the registry only uses this for the boot/status line.
        match std::env::var("KUBECONFIG").ok().filter(|s| !s.is_empty()) {
            Some(_) => BackendAvailability::Available,
            None => {
                // In-cluster config presence (a mounted service-account token).
                if std::path::Path::new("/var/run/secrets/kubernetes.io/serviceaccount/token")
                    .exists()
                {
                    BackendAvailability::Available
                } else {
                    BackendAvailability::Unavailable("no KUBECONFIG or in-cluster config".into())
                }
            }
        }
    }

    fn supports(&self, class: ResourceClass) -> bool {
        matches!(
            class,
            ResourceClass::Gpu | ResourceClass::Highmem | ResourceClass::ClusterBatch
        )
    }

    /// The job-per-run pod stages inputs + collects outputs IN THE POD (the `run-job`
    /// entrypoint) — the control-plane runner must NOT materialize inputs locally for it, and
    /// the executor must skip its local finalize (ITEM-1/2 / #66).
    fn stages_inputs_remotely(&self) -> bool {
        true
    }
}

/// Stream the Job's pod logs into `sink` and block until the Job reaches a terminal state;
/// return the pod's exit code (0 on success, 1 on failure/unknown). Best-effort throughout —
/// a log/watch hiccup degrades to no-progress, never a panic.
async fn watch_job_to_exit(
    client: Client,
    api: Api<Job>,
    namespace: &str,
    name: &str,
    sink: Arc<dyn ProgressSink>,
    max_wait_secs: u64,
) -> i32 {
    use k8s_openapi::api::core::v1::Pod;
    use std::time::Duration;

    let pods: Api<Pod> = Api::namespaced(client, namespace);
    let mut logs_started = false;
    let mut pod_name: Option<String> = None;

    // Poll the Job status until terminal; opportunistically start a live follow-log stream
    // once the pod's container is RUNNING (a `log_stream` on a still-creating container errors,
    // so latching on mere pod-existence would give up before any log — that raced a fast pod).
    // The ceiling derives from the job's own deadline (#66 FIX-1) so a legitimately long heavy
    // job is not cut off by a fixed short bound; it sits ABOVE the Job's activeDeadlineSeconds so
    // k8s reaps a stuck pod first (a Failed status this loop then observes). 200ms per iteration.
    let iterations = (max_wait_secs.saturating_mul(1000) / 200).max(1);
    for _ in 0..iterations {
        if !logs_started {
            if let Ok(list) = pods
                .list(&ListParams::default().labels(&format!("job-name={name}")))
                .await
            {
                if let Some(pod) = list.items.into_iter().next() {
                    let running = pod
                        .status
                        .as_ref()
                        .and_then(|s| s.phase.as_deref())
                        .map(|p| p == "Running" || p == "Succeeded" || p == "Failed")
                        .unwrap_or(false);
                    if let Some(n) = pod.metadata.name.clone() {
                        pod_name = Some(n.clone());
                        if running {
                            logs_started = true;
                            let pods_c = pods.clone();
                            let sink_c = sink.clone();
                            tokio::spawn(async move {
                                stream_pod_logs(pods_c, &n, sink_c).await;
                            });
                        }
                    }
                }
            }
        }
        if let Ok(job) = api.get_status(name).await {
            if let Some(status) = job.status {
                let exit = if status.succeeded.unwrap_or(0) > 0 {
                    Some(0)
                } else if status.failed.unwrap_or(0) > 0 {
                    Some(1)
                } else {
                    None
                };
                if let Some(code) = exit {
                    // Guaranteed final capture: fetch the pod's COMPLETE logs (non-follow) once
                    // on terminal, so a fast pod whose follow-stream never attached still lands
                    // its output in the sink (the follow stream above is live-progress only).
                    if let Some(ref pn) = pod_name {
                        drain_pod_logs_once(&pods, pn, &sink).await;
                    }
                    return code;
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    1
}

/// Fetch a pod's complete logs once (non-follow) and push each line to the sink. The reliable
/// backstop the terminal path uses so a fast pod's output is never lost to a follow-stream race.
async fn drain_pod_logs_once(
    pods: &kube::Api<k8s_openapi::api::core::v1::Pod>,
    pod_name: &str,
    sink: &Arc<dyn ProgressSink>,
) {
    use kube::api::LogParams;
    if let Ok(text) = pods.logs(pod_name, &LogParams::default()).await {
        for line in text.lines() {
            sink.progress(ProgressFrame {
                phase: "k8s".into(),
                pct: None,
                message: Some(line.to_string()),
            });
        }
    }
}

/// Follow a pod's logs, forwarding each line to the `ProgressSink` as a `message` frame.
async fn stream_pod_logs(
    pods: kube::Api<k8s_openapi::api::core::v1::Pod>,
    pod_name: &str,
    sink: Arc<dyn ProgressSink>,
) {
    // `Api::log_stream` yields a `futures` `AsyncBufRead`, so use the futures line adapter
    // (not tokio's) — avoids a compat shim + a new tokio-util cargo feature.
    use futures_util::io::AsyncBufReadExt;
    use futures_util::StreamExt;
    use kube::api::LogParams;

    let params = LogParams {
        follow: true,
        ..Default::default()
    };
    let stream = match pods.log_stream(pod_name, &params).await {
        Ok(s) => s,
        Err(_) => return,
    };
    let mut lines = stream.lines();
    while let Some(Ok(line)) = lines.next().await {
        sink.progress(ProgressFrame {
            phase: "k8s".into(),
            pct: None,
            message: Some(line),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::sandbox::backend::{PriorityClass, ResourceProfile};

    /// Serializes the tests that mutate the PROCESS-WIDE `CYTO_*` pod-shape variables.
    ///
    /// This delegates to the CRATE-WIDE `env_image::process_env_guard` rather than owning
    /// a private mutex, because the state genuinely overlaps: `build_job` resolves the
    /// pod's env through `env_image::resolve_env_id`, which reads `CYTO_SANDBOX_ENV_ID`
    /// and the settings-cache snapshot — the very globals the `env_image` tests set. A
    /// private lock here would guard the pod-shape half of that state and race on the
    /// other half, which is a slower race, not isolation.
    fn pod_env_guard() -> std::sync::MutexGuard<'static, ()> {
        crate::modules::sandbox::env_image::process_env_guard()
    }

    /// Restores a `CYTO_*` variable on drop, so a PANICKING assertion cannot leave the
    /// process environment dirty for every later test in the binary (which is how one
    /// test's real failure turns into three unrelated ones).
    struct EnvVarGuard(&'static str, Option<String>);
    impl EnvVarGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let prev = std::env::var(key).ok();
            std::env::set_var(key, value);
            EnvVarGuard(key, prev)
        }
        fn clear(key: &'static str) -> Self {
            let prev = std::env::var(key).ok();
            std::env::remove_var(key);
            EnvVarGuard(key, prev)
        }
    }
    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            match &self.1 {
                Some(v) => std::env::set_var(self.0, v),
                None => std::env::remove_var(self.0),
            }
        }
    }

    fn spec(class: ResourceClass) -> ComputeSpec {
        ComputeSpec {
            job_id: uuid::Uuid::from_u128(0x1234_5678_9abc_def0),
            workspace_root: std::path::PathBuf::from("/remote"),
            outputs_dir: std::path::PathBuf::from("/remote"),
            command: String::new(),
            input_mounts: vec![],
            code_mount: None,
            extra_mounts: vec![],
            profile: ResourceProfile {
                memory_max_bytes: 1 << 30,
                memory_swap_max_bytes: 1 << 30,
                pids_max: 128,
                cpu_max: "100000 100000".into(),
                timeout_secs: 60,
            },
            priority: PriorityClass::Normal,
            resource_class: class,
            // #189 test fixture default: no per-job env. Cases that need one set it.
            env_id: None,
        }
    }

    fn container_of(job: &Job) -> &Container {
        &job.spec.as_ref().unwrap().template.spec.as_ref().unwrap().containers[0]
    }
    fn env_of<'a>(c: &'a Container, name: &str) -> Option<&'a str> {
        c.env
            .as_ref()?
            .iter()
            .find(|e| e.name == name)
            .and_then(|e| e.value.as_deref())
    }
    fn mount_path_of<'a>(c: &'a Container, vol: &str) -> Option<&'a str> {
        c.volume_mounts
            .as_ref()?
            .iter()
            .find(|m| m.name == vol)
            .map(|m| m.mount_path.as_str())
    }

    // TEST-1 (ITEM-1 / INV-1/2): the KubernetesBackend stages inputs REMOTELY (the control-plane
    // runner must skip local staging + finalize for it). The default-false negative control lives
    // in local_bwrap's TEST-4.
    #[test]
    fn test_1_kubernetes_stages_inputs_remotely() {
        let be = KubernetesBackend::from_config("ns".into(), "img".into());
        assert!(be.stages_inputs_remotely());
    }

    // TEST-2 (ITEM-6 / INV-1): the job-per-run manifest runs `cytoanalyst run-job --job-id <id>`
    // (NOT the raw spec.command) with the app-data scratch workspace, the config Secret mount +
    // CONFIG_FILE, the env-rootfs env, CYTO_SCHEDULER_ENABLED=off, restartPolicy Never,
    // backoffLimit 0, and the per-class nodeSelector.
    #[test]
    fn test_2_build_job_wires_the_run_job_data_plane_command_and_mounts() {
        let _env = pod_env_guard();
        // The pod's env-id is now RESOLVED (not a literal), so this assertion depends on
        // the operator override being clear — an ambient value would be stamped in.
        let _ovr = EnvVarGuard::clear("CYTO_SANDBOX_ENV_ID");
        let be = KubernetesBackend::from_config("ns".into(), "img".into());
        let s = spec(ResourceClass::ClusterBatch);
        // Deterministic: clear any ambient overrides so defaults apply.
        for v in ["CYTO_K8S_PRIVILEGED", "CYTO_K8S_CONFIG_DIR", "CYTO_APP_DATA_DIR",
                  "CYTO_ENV_ROOTFS_FETCHER_IMAGE", "CYTO_K8S_ENV_SECRET"] {
            std::env::remove_var(v);
        }
        let job = be.build_job(&s, "cyto-abc", "ns", "img");
        let c = container_of(&job);
        // The command is the in-pod one-shot executor for THIS job id.
        assert_eq!(
            c.command.as_ref().unwrap(),
            &vec![
                "cytoanalyst".to_string(),
                "run-job".to_string(),
                "--job-id".to_string(),
                s.job_id.to_string()
            ]
        );
        // Config Secret mount + CONFIG_FILE env; the Secret volume is OPTIONAL (a missing Secret
        // yields a clean run-job failure, not a stuck pod).
        assert_eq!(mount_path_of(c, "worker-config"), Some("/etc/cytoanalyst"));
        assert_eq!(env_of(c, "CONFIG_FILE"), Some("/etc/cytoanalyst/config.yaml"));
        let cfg_vol = job.spec.as_ref().unwrap().template.spec.as_ref().unwrap()
            .volumes.as_ref().unwrap().iter().find(|v| v.name == "worker-config").unwrap();
        assert_eq!(cfg_vol.secret.as_ref().unwrap().optional, Some(true));
        // App-data scratch workspace (inputs/outputs staging).
        assert_eq!(mount_path_of(c, "app-data"), Some("/var/lib/cytoanalyst"));
        // Env-rootfs delivery.
        assert_eq!(
            env_of(c, "CYTO_ENV_ROOTFS_SQUASHFS"),
            Some("/var/lib/cytoanalyst/env-rootfs/rootfs.squashfs")
        );
        // #189 — with the operator override cleared, this spec declaring no env, and no
        // registry loaded in a unit test, there is nothing to derive: the var is OMITTED
        // rather than stamped with an invented name. It previously asserted a hardcoded `"cyto-default"`, which was
        // both the env-name literal INV-4 forbids and a DANGLING one — no such recipe
        // exists under `src-app/env-rootfs/`, so a pod launched with it asked the
        // registry for a repo that was never published. The per-job case is asserted in
        // `the_pod_env_id_is_per_job_and_never_a_literal`.
        assert_eq!(env_of(c, "CYTO_SANDBOX_ENV_ID"), None);
        assert_eq!(env_of(c, "CYTO_SCHEDULER_ENABLED"), Some("off"));
        assert_eq!(mount_path_of(c, "env-rootfs"), Some("/var/lib/cytoanalyst/env-rootfs"));
        // Job scheduling shape (no silent retry) + node placement.
        let js = job.spec.as_ref().unwrap();
        assert_eq!(js.backoff_limit, Some(0));
        let ps = js.template.spec.as_ref().unwrap();
        assert_eq!(ps.restart_policy.as_deref(), Some("Never"));
        assert_eq!(
            ps.node_selector.as_ref().unwrap().get("cyto.io/pool").map(|s| s.as_str()),
            Some("batch")
        );
    }

    // TEST-3 (ITEM-6 / INV-6): the squashfuse securityContext defaults to privileged:true
    // (deploy-spike), overridable to false; and the env-rootfs init-container is present iff a fetcher
    // image is configured.
    #[test]
    fn test_3_security_context_privileged_default_and_optional_env_rootfs_initcontainer() {
        let _env = pod_env_guard();
        let be = KubernetesBackend::from_config("ns".into(), "img".into());
        let s = spec(ResourceClass::Gpu);

        // Default (unset) → privileged true, and NO init-container (rootfs baked in the image).
        std::env::remove_var("CYTO_K8S_PRIVILEGED");
        std::env::remove_var("CYTO_ENV_ROOTFS_FETCHER_IMAGE");
        let job = be.build_job(&s, "cyto-a", "ns", "img");
        let c = container_of(&job);
        assert_eq!(c.security_context.as_ref().unwrap().privileged, Some(true));
        assert!(job.spec.as_ref().unwrap().template.spec.as_ref().unwrap().init_containers.is_none());

        // Fetcher image set → an init-container that writes the shared env-rootfs volume.
        std::env::set_var("CYTO_ENV_ROOTFS_FETCHER_IMAGE", "ghcr.io/x/rootfs-fetch:1");
        std::env::set_var("CYTO_K8S_PRIVILEGED", "false");
        let job2 = be.build_job(&s, "cyto-b", "ns", "img");
        let c2 = container_of(&job2);
        assert_eq!(c2.security_context.as_ref().unwrap().privileged, Some(false));
        let inits = job2.spec.as_ref().unwrap().template.spec.as_ref().unwrap()
            .init_containers.as_ref().expect("init-container present when fetcher set");
        assert_eq!(inits[0].name, "fetch-env-rootfs");
        assert_eq!(inits[0].image.as_deref(), Some("ghcr.io/x/rootfs-fetch:1"));
        assert_eq!(
            inits[0].volume_mounts.as_ref().unwrap()[0].mount_path,
            "/env-rootfs"
        );
        std::env::remove_var("CYTO_ENV_ROOTFS_FETCHER_IMAGE");
        std::env::remove_var("CYTO_K8S_PRIVILEGED");
    }

    // TEST-11 (ITEM-6 / INV-6): defense-in-depth orphan cleanup is preserved even with the
    // richer manifest — the Job still sets ttl_seconds_after_finished + backoffLimit 0 (the
    // Drop-guard delete is exercised by the kind-gated integration test).
    #[test]
    fn test_11_manifest_preserves_orphan_cleanup_fields() {
        let _env = pod_env_guard();
        let be = KubernetesBackend::from_config("ns".into(), "img".into());
        let s = spec(ResourceClass::Highmem);
        let job = be.build_job(&s, "cyto-c", "ns", "img");
        let js = job.spec.as_ref().unwrap();
        assert_eq!(js.ttl_seconds_after_finished, Some(120));
        assert_eq!(js.backoff_limit, Some(0));
        // FIX-1: k8s-enforced whole-run wall-clock, set ABOVE the analysis budget (so staging +
        // upload fit) — a long heavy job is not force-killed by a fixed short ceiling.
        std::env::remove_var("CYTO_K8S_JOB_DEADLINE_SLACK_SECS");
        let job2 = be.build_job(&s, "cyto-c2", "ns", "img");
        let deadline = job2.spec.as_ref().unwrap().active_deadline_seconds.unwrap();
        assert!(
            deadline > s.profile.timeout_secs as i64,
            "activeDeadlineSeconds ({deadline}) exceeds the analysis budget ({}) by the \
             staging/upload slack",
            s.profile.timeout_secs
        );
    }

    // TEST-9 (ITEM-7 / INV-4): launch REFUSES with a clear BACKEND_UNAVAILABLE naming the object
    // store when none is configured — a heavy-class job never silently runs input-less. The
    // refusal precedes any Job create, so no cluster is needed. (In the unit-test binary the
    // process-global object store is never initialized → None.)
    #[tokio::test]
    async fn test_9_launch_refuses_without_object_store() {
        use crate::modules::sandbox::backend::NullProgressSink;
        if crate::modules::workstore::try_get_object_store().is_some() {
            // Another test initialized the global store; the refusal precondition can't be set up
            // here. Skip rather than assert a false negative (the contract is still covered by the
            // code path + the integration coverage).
            return;
        }
        let be = KubernetesBackend::from_config("ns".into(), "img".into());
        let err = match be
            .launch(spec(ResourceClass::Gpu), std::sync::Arc::new(NullProgressSink))
            .await
        {
            Ok(_) => panic!("must refuse without an object store"),
            Err(e) => e,
        };
        assert_eq!(err.error_code(), "BACKEND_UNAVAILABLE");
        assert!(
            err.to_string().to_lowercase().contains("object store"),
            "clear reason names the object store: {err}"
        );
    }

    /// **TEST-E1-10** [covers: ITEM-12] **PROV-E1-6** — the pod's env-id is PER-JOB, and
    /// no env-name literal appears in this backend.
    ///
    /// Two claims, both of which the previous code failed:
    ///
    /// 1. `PodShape::from_env()` reads only the process environment and takes no
    ///    `ComputeSpec`, so before #189 every pod in a deployment got the SAME env-id
    ///    however many envs its jobs declared — per-job selection could not reach the
    ///    remote path at all.
    /// 2. Its fallback was the string `"cyto-default"`, an env name typed into the app
    ///    core. Nothing published that repo, so it was also dangling.
    ///
    /// The main container and the rootfs-fetcher init-container are asserted TOGETHER
    /// because they must agree: if the init container prefetched one env's rootfs while
    /// the main container resolved another, the pod would mount the wrong image with
    /// nothing reporting it.
    /// Lifecycle id: **TEST-18** (see `.lifecycle/analysis-env-selection/TESTS.md`).
    #[test]
    fn the_pod_env_id_is_per_job_and_never_a_literal() {
        let _env = pod_env_guard();
        const JOB_ENV: &str = "fixture-job-env";
        // The operator override OUTRANKS a declared env (PROV-E1-2), so it must be clear
        // for this test to be asserting the per-job path at all — otherwise an ambient
        // value would make it pass or fail for the wrong reason.
        let _ovr = EnvVarGuard::clear("CYTO_SANDBOX_ENV_ID");
        let _fetch = EnvVarGuard::set("CYTO_ENV_ROOTFS_FETCHER_IMAGE", "fetcher:1");
        let be = KubernetesBackend::from_config("ns".into(), "img".into());
        for v in ["CYTO_K8S_PRIVILEGED", "CYTO_K8S_CONFIG_DIR", "CYTO_APP_DATA_DIR",
                  "CYTO_K8S_ENV_SECRET"] {
            std::env::remove_var(v);
        }
        let mut s = spec(ResourceClass::ClusterBatch);
        s.env_id = Some(JOB_ENV.to_string());
        let job = be.build_job(&s, "cyto-abc", "ns", "img");

        // The MAIN container carries the job's declared env.
        assert_eq!(
            env_of(container_of(&job), "CYTO_SANDBOX_ENV_ID"),
            Some(JOB_ENV),
            "the pod runs the env THIS JOB declared, not a deployment-wide one"
        );

        // …and the INIT container carries the SAME one.
        let init = job.spec.as_ref().unwrap().template.spec.as_ref().unwrap()
            .init_containers.as_ref().expect("a fetcher image yields an init-container")
            .first().unwrap().clone();
        let init_env = init.env.as_ref().unwrap().iter()
            .find(|e| e.name == "CYTO_SANDBOX_ENV_ID")
            .and_then(|e| e.value.clone());
        assert_eq!(
            init_env.as_deref(),
            Some(JOB_ENV),
            "the rootfs fetcher must prefetch the SAME env the main container resolves"
        );

    }

    /// **PROV-E1-6** — no env-name literal anywhere in this backend's SOURCE.
    ///
    /// A derived reader is only derived while nobody re-adds a constant next to it, and
    /// the previous literal survived precisely because no test looked. This reads the
    /// file rather than the behaviour, deliberately: behaviour tests pass whenever the
    /// literal happens not to be reached, which is how `"cyto-default"` sat here unused
    /// on the local path and wrong on the remote one.
    ///
    /// Scoped to the two spellings that actually shipped plus the recipe directories on
    /// disk, so a new env recipe is covered with no edit here (derived subject, not a
    /// typed list).
    /// Lifecycle id: **TEST-19** (see `.lifecycle/analysis-env-selection/TESTS.md`).
    #[test]
    fn this_backend_carries_no_env_name_literal() {
        let src = include_str!("kubernetes.rs");
        // The lines that MENTION the retired literal are this file's own explanatory
        // comments; a re-introduction would be a string literal in code. Strip comments
        // before matching so the guard cannot be defeated, or falsely fired, by prose.
        let code: String = src
            .lines()
            .filter(|l| !l.trim_start().starts_with("//") && !l.trim_start().starts_with("///"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            !code.contains("\"cyto-default\""),
            "the retired env-name literal is back in this backend's code"
        );
        // DERIVED subject: every env recipe the repo actually ships. A new recipe is
        // covered automatically; a removed one drops out. Never a list typed here.
        let env_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../env-rootfs");
        let mut checked = 0usize;
        if let Ok(rd) = std::fs::read_dir(&env_root) {
            for e in rd.flatten().filter(|e| e.path().is_dir()) {
                let name = e.file_name().to_string_lossy().to_string();
                assert!(
                    !code.contains(&format!("\"{name}\"")),
                    "the env-id {name:?} is a literal in the k8s backend; it is DATA the \
                     manifests declare, so it must be derived"
                );
                checked += 1;
            }
        }
        // Anti-vacuity floor: if the path is ever re-pointed, this test would assert
        // nothing at all while still printing PASS — the exact defect the derived
        // vocabulary guard exists to retire.
        assert!(
            checked >= 1,
            "no env recipe discovered under {} — the assertion above was vacuous; \
             re-point the path rather than deleting this floor",
            env_root.display()
        );
    }
}
